// Edge module — orchestrates DB writes + external API calls.
// Per CLAUDE.md "Pure core, side effects at edges": this module owns the I/O;
// indicator/scoring math lives in `./analysis` (pure).

import YahooFinance from "yahoo-finance2";
import { db } from "./db";
import { getHistory } from "./market-data";
import { analyzeStock } from "./analysis";
import {
  FETCHER_CONFIG,
  EARNINGS_CONFIG,
  LOG_PERSISTENCE_CONFIG,
  NEWS_CONFIG,
  FUNDAMENTALS_CONFIG,
  INSIDERS_CONFIG,
  ANALYSTS_CONFIG,
  REGIME_CONFIG,
} from "./config";
import { log } from "./logger";
import {
  validateHistory,
  shouldQuarantine,
  maxSeverity,
  type DataQualityIssue,
} from "./data-quality";
import { applyEarningsAdjustment } from "./earnings";
import {
  refreshEarningsCalendar,
  getNextEarningsForSymbol,
} from "./earnings-source";
import {
  refreshNewsForWatchlist,
  getRecentNewsForSymbol,
  getOrCacheDiagnosis,
} from "./news-source";
import { applyDiagnosisAdjustment } from "./diagnosis";
import {
  refreshAllFundamentals,
  getFundamentalsForSymbol,
} from "./fundamentals-source";
import { applyFundamentalsAdjustment } from "./fundamentals";
import {
  refreshAllInsiders,
  getRecentInsiderTxnsForSymbol,
} from "./insiders-source";
import { applyInsiderAdjustment, evaluateInsiderActivity } from "./insiders";
import {
  refreshAllAnalysts,
  getRecentAnalystActionsForSymbol,
} from "./analysts-source";
import { applyAnalystAdjustment, evaluateAnalystActivity } from "./analysts";
import {
  refreshRegimeSnapshot,
  getCurrentRegime,
} from "./regime-source";
import { applyRegimeAdjustment } from "./regime";
import { applyCatalystAdjustment } from "./catalysts";
import {
  refreshSectorRotation,
  getCurrentSectorRotationMap,
} from "./sector-rotation-source";
import { attachSectorRotation } from "./sector-rotation";
import {
  refreshAllOptions,
  getLatestOptionsForSymbol,
} from "./options-source";
import { applyOptionsAdjustment } from "./options";
import { SECTOR_ROTATION_CONFIG, OPTIONS_CONFIG } from "./config";
import { registerCron, startAll, stopAll } from "./scheduler";
import { sleep } from "./throttle";
import type { Regime, SectorRotationInfo } from "@/types";
import { pruneOldLogs } from "./log-persistence";
import {
  maybeLogRecommendation,
  pruneOldRecommendations,
} from "./recommendation-log";
import { RECOMMENDATION_LOG_CONFIG } from "./config";

const yf = new YahooFinance();

let isRunning = false;
let lastRunAt: Date | null = null;
let lastCompletedAt: Date | null = null;

async function persistQualityIssues(
  symbol: string,
  issues: DataQualityIssue[]
): Promise<void> {
  if (issues.length === 0) return;
  // Best-effort persistence; never let an audit-log error abort ingestion.
  try {
    await db.dataQualityLog.createMany({
      data: issues.map((i) => ({
        symbol,
        type: i.type,
        severity: i.severity,
        detail: i.detail,
      })),
    });
  } catch (err) {
    log.warn("data-quality", "log.persist.failure", { symbol, error: err });
  }
}

async function fetchBatch(
  stocks: { symbol: string; name: string; sector: string }[],
  regime: Regime | null,
  sectorRotationMap: Map<string, SectorRotationInfo>
): Promise<number> {
  const results = await Promise.allSettled(
    stocks.map(async (stock) => {
      const history = await getHistory(
        stock.symbol,
        FETCHER_CONFIG.historyDaysForRefresh
      );

      // ── Phase 0 firewall: validate before publishing ──
      const issues = validateHistory(history);
      if (issues.length > 0) {
        await persistQualityIssues(stock.symbol, issues);
      }
      if (shouldQuarantine(issues)) {
        log.warn("fetcher", "quarantine", {
          symbol: stock.symbol,
          severity: maxSeverity(issues),
          issueCount: issues.length,
          types: Array.from(new Set(issues.map((i) => i.type))),
        });
        return null;
      }

      // Defensive: if validation passed but we somehow have too few bars,
      // skip rather than feed `analyzeStock` something it can't analyse.
      if (history.length < FETCHER_CONFIG.minHistoryBars) return null;

      const baseAnalysis = analyzeStock(stock.symbol, history);

      // ── Phase 3: decorate with earnings info & apply adjustment ──
      // Look up the next earnings from the local cache (refreshed nightly).
      // Failure here is non-fatal — fall through with the un-decorated
      // analysis rather than skipping the symbol entirely.
      let analysis = baseAnalysis;
      try {
        const earnings = await getNextEarningsForSymbol(stock.symbol);
        analysis = applyEarningsAdjustment(baseAnalysis, earnings);
      } catch (err) {
        log.warn("fetcher", "earnings.decorate.failure", {
          symbol: stock.symbol,
          error: err,
        });
      }

      // ── Phase 4: decorate with news-driven diagnosis ──
      // Read recent news from the local cache (refreshed daily by the news
      // cron). Failure is non-fatal — fall through with the un-diagnosed
      // analysis rather than dropping the symbol.
      try {
        const recentNews = await getRecentNewsForSymbol(stock.symbol);
        const diagnosis = await getOrCacheDiagnosis(
          stock.symbol,
          recentNews.map((n) => n.headline)
        );
        analysis = applyDiagnosisAdjustment(analysis, diagnosis);
      } catch (err) {
        log.warn("fetcher", "diagnosis.decorate.failure", {
          symbol: stock.symbol,
          error: err,
        });
      }

      // ── Phase 5: insider activity ──
      // Cluster insider buys (≥2 distinct insiders within 14 days) nudge
      // the score up; failure here is non-fatal — the analysis just
      // doesn't get the boost.
      try {
        const txns = await getRecentInsiderTxnsForSymbol(stock.symbol);
        const activity = evaluateInsiderActivity(txns);
        analysis = applyInsiderAdjustment(analysis, activity);
      } catch (err) {
        log.warn("fetcher", "insiders.decorate.failure", {
          symbol: stock.symbol,
          error: err,
        });
      }

      // ── Phase 5: analyst rating actions ──
      try {
        const actions = await getRecentAnalystActionsForSymbol(stock.symbol);
        const activity = evaluateAnalystActivity(actions);
        analysis = applyAnalystAdjustment(analysis, activity);
      } catch (err) {
        log.warn("fetcher", "analysts.decorate.failure", {
          symbol: stock.symbol,
          error: err,
        });
      }

      // ── Phase 6: regime weight adjustment ──
      // Re-weights each signal's contribution to the composite score based
      // on the broad market regime. Cold start (`regime == null`) skips
      // the adjustment — better to ship raw scores than wait. The pure
      // `applyRegimeAdjustment` recomputes the recommendation from the
      // adjusted score and attaches `regime` metadata for the UI.
      if (regime !== null) {
        analysis = applyRegimeAdjustment(analysis, regime);
      }

      // ── Phase 8: options market signals ──
      // Reads the latest persisted OptionsSnapshot (refreshed daily) and
      // applies IV-rank + unusual-flow score adjustments. Failure is
      // non-fatal — the analysis just doesn't get the options decoration.
      try {
        const options = await getLatestOptionsForSymbol(stock.symbol);
        if (options !== null) {
          analysis = applyOptionsAdjustment(analysis, options);
        }
      } catch (err) {
        log.warn("fetcher", "options.decorate.failure", {
          symbol: stock.symbol,
          error: err,
        });
      }

      // ── Phase 7.1: sector rotation decoration ──
      // Attach the sector's rotation state (if we track it) so the
      // catalyst aggregator below can fire on `turning_up` sectors. Pure
      // lookup against the snapshot map read once at cycle start.
      const sectorInfo = sectorRotationMap.get(stock.sector) ?? null;
      analysis = attachSectorRotation(analysis, sectorInfo);

      // ── Phase 7: catalyst aggregation ──
      // Pure — reads the catalyst-shaped fields that Phases 3/4/5/7.1
      // already attached and produces the confidence indicator. Runs
      // *before* the fundamentals veto so vetoed-but-still-cached
      // analyses still carry a catalyst readout for audit purposes.
      analysis = applyCatalystAdjustment(analysis);

      // ── Phase 4.5: fundamentals veto ──
      // Reads the weekly-refreshed snapshot from DB (cold start = null →
      // skip the check rather than veto-everything). The decision lives in
      // the pure `applyFundamentalsAdjustment`; this just orchestrates the
      // read.
      try {
        const fundamentals = await getFundamentalsForSymbol(stock.symbol);
        analysis = applyFundamentalsAdjustment(analysis, fundamentals);
      } catch (err) {
        log.warn("fetcher", "fundamentals.decorate.failure", {
          symbol: stock.symbol,
          error: err,
        });
      }

      // ── Phase 2.5: log the quality-gate veto so it shows up on /logs ──
      // The analysis itself is still cached (so `?includeVetoed=true` works
      // for audit), we just emit a structured warn so the user can see
      // *which* names were filtered and *why* in the same view they use to
      // see Phase 0 quarantines.
      if (analysis.qualityVeto) {
        log.warn("fetcher", "quality-veto", {
          symbol: stock.symbol,
          reason: analysis.qualityVeto.reason,
          detail: analysis.qualityVeto.detail,
        });
      }

      const data = JSON.stringify({
        symbol: stock.symbol,
        name: stock.name,
        sector: stock.sector,
        analysis,
      });

      await db.analysisCache.upsert({
        where: { symbol: stock.symbol },
        update: { data, fetchedAt: new Date() },
        create: { symbol: stock.symbol, data, fetchedAt: new Date() },
      });

      // ── Phase 11: append to the audit timeline when something
      // externally-observable changed. `maybeLogRecommendation` is
      // best-effort — failures are logged internally and never
      // thrown, so an audit-log hiccup can never break the fetcher.
      await maybeLogRecommendation(stock.symbol, analysis);

      return stock.symbol;
    })
  );

  return results.filter(
    (r) => r.status === "fulfilled" && r.value !== null
  ).length;
}

export async function refreshAllStocks(): Promise<{
  total: number;
  succeeded: number;
  duration: number;
}> {
  if (isRunning) {
    log.info("fetcher", "refresh.skip", { reason: "already-running" });
    return { total: 0, succeeded: 0, duration: 0 };
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    const watchlist = await db.watchlistStock.findMany({
      orderBy: { addedAt: "asc" },
    });

    // Read the current market regime once per cycle; failures shouldn't
    // block the refresh (analyses just get no regime adjustment).
    let regime: Regime | null = null;
    try {
      regime = await getCurrentRegime();
    } catch (err) {
      log.warn("fetcher", "regime.read.failure", { error: err });
    }

    // Read the sector-rotation map once per cycle (Phase 7.1). Empty map
    // on cold start or DB failure — analyses simply don't get the
    // sector_rotation catalyst until the cron has run.
    let sectorRotationMap = new Map<string, SectorRotationInfo>();
    try {
      sectorRotationMap = await getCurrentSectorRotationMap();
    } catch (err) {
      log.warn("fetcher", "sector-rotation.read.failure", { error: err });
    }

    log.info("fetcher", "refresh.start", {
      count: watchlist.length,
      regime: regime ?? "unknown",
      sectorRotationsTracked: sectorRotationMap.size,
    });

    let succeeded = 0;
    const { batchSize, batchDelayMs, progressLogEveryNBatches } = FETCHER_CONFIG;

    for (let i = 0; i < watchlist.length; i += batchSize) {
      const batch = watchlist.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(watchlist.length / batchSize);

      const count = await fetchBatch(batch, regime, sectorRotationMap);
      succeeded += count;

      if (i + batchSize < watchlist.length) {
        await sleep(batchDelayMs);
      }

      if (batchNum % progressLogEveryNBatches === 0 || batchNum === totalBatches) {
        log.info("fetcher", "refresh.progress", {
          batchNum,
          totalBatches,
          succeeded,
        });
      }
    }

    const duration = Date.now() - startTime;
    lastRunAt = new Date();
    lastCompletedAt = new Date();
    log.info("fetcher", "refresh.done", {
      succeeded,
      total: watchlist.length,
      durationMs: duration,
    });

    return { total: watchlist.length, succeeded, duration };
  } catch (err) {
    log.error("fetcher", "refresh.error", { error: err });
    throw err;
  } finally {
    isRunning = false;
  }
}

// ─── Auto-discovery: add trending stocks to watchlist ───

async function discoverTrendingStocks() {
  try {
    const trending = await yf.trendingSymbols("US", {
      count: FETCHER_CONFIG.trendingFetchCount,
    });
    const symbols = (trending.quotes ?? [])
      .map((q: { symbol: string }) => q.symbol)
      .filter((s: string) => !s.includes("-") && !s.includes("."));

    let added = 0;
    for (const symbol of symbols) {
      const exists = await db.watchlistStock.findUnique({ where: { symbol } });
      if (exists) continue;

      try {
        const quote = await yf.quote(symbol);
        if (!quote || !quote.shortName) continue;

        const sector = mapQuoteToSector(quote.sector ?? quote.industry ?? "");
        await db.watchlistStock.create({
          data: {
            symbol,
            name: quote.shortName ?? symbol,
            sector,
          },
        });
        added++;
      } catch (err) {
        // Per-symbol failure is non-fatal: a transient quote error shouldn't
        // abort discovery for the rest of the batch. Logged for observability.
        log.warn("discovery", "quote.failure", { symbol, error: err });
      }
    }

    if (added > 0) {
      log.info("discovery", "watchlist.added", { added });
    }
  } catch (err) {
    log.error("discovery", "trending.error", { error: err });
  }
}

function mapQuoteToSector(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("tech") || s.includes("software") || s.includes("semiconductor")) return "Tech";
  if (s.includes("health") || s.includes("pharma") || s.includes("biotech")) return "Healthcare";
  if (s.includes("financ") || s.includes("bank") || s.includes("insurance")) return "Finance";
  if (s.includes("energy") || s.includes("oil") || s.includes("gas")) return "Energy";
  if (s.includes("consumer") || s.includes("retail") || s.includes("food")) return "Consumer";
  if (s.includes("industr") || s.includes("manufact")) return "Industrial";
  if (s.includes("communi") || s.includes("media") || s.includes("entertain")) return "Comm";
  if (s.includes("real estate")) return "REIT";
  if (s.includes("material") || s.includes("chemical") || s.includes("mining")) return "Materials";
  if (s.includes("utilit")) return "Utilities";
  if (s.includes("auto")) return "Auto";
  if (s.includes("aero") || s.includes("defense")) return "Aerospace";
  return "Other";
}

/**
 * Build the cron table that owns every recurring task in the app. One
 * `registerCron` call per task — the scheduler handles armed-state,
 * lifecycle, error catching, and overlap protection. Adding a new cron
 * is a one-line change here (was: a `let xId`, a `safeX()`, a
 * `setInterval`, and a cleanup block — four touch points).
 */
function registerCrons(): void {
  const { refreshIntervalMs, discoveryIntervalMs } = FETCHER_CONFIG;

  registerCron({
    name: "fetcher.refresh",
    intervalMs: refreshIntervalMs,
    run: () => refreshAllStocks(),
  });
  registerCron({
    name: "discovery.refresh",
    intervalMs: discoveryIntervalMs,
    run: () => discoverTrendingStocks(),
  });
  registerCron({
    name: "earnings.refresh",
    intervalMs: EARNINGS_CONFIG.refreshIntervalMs,
    run: () => refreshEarningsCalendar(),
  });
  registerCron({
    name: "news.refresh",
    intervalMs: NEWS_CONFIG.refreshIntervalMs,
    run: () => refreshNewsForWatchlist(),
  });
  registerCron({
    name: "fundamentals.refresh",
    intervalMs: FUNDAMENTALS_CONFIG.refreshIntervalMs,
    run: () => refreshAllFundamentals(),
  });
  registerCron({
    name: "insiders.refresh",
    intervalMs: INSIDERS_CONFIG.refreshIntervalMs,
    run: () => refreshAllInsiders(),
  });
  registerCron({
    name: "analysts.refresh",
    intervalMs: ANALYSTS_CONFIG.refreshIntervalMs,
    run: () => refreshAllAnalysts(),
  });
  registerCron({
    name: "regime.refresh",
    intervalMs: REGIME_CONFIG.refreshIntervalMs,
    run: () => refreshRegimeSnapshot(),
  });
  registerCron({
    name: "sector-rotation.refresh",
    intervalMs: SECTOR_ROTATION_CONFIG.refreshIntervalMs,
    run: () => refreshSectorRotation(),
  });
  registerCron({
    name: "options.refresh",
    intervalMs: OPTIONS_CONFIG.refreshIntervalMs,
    run: () => refreshAllOptions(),
  });
  registerCron({
    name: "log-prune",
    intervalMs: LOG_PERSISTENCE_CONFIG.pruneIntervalMs,
    run: async () => {
      const deleted = await pruneOldLogs();
      if (deleted > 0) log.info("log-prune", "done", { deleted });
    },
  });
  registerCron({
    name: "audit-log.prune",
    intervalMs: RECOMMENDATION_LOG_CONFIG.pruneIntervalMs,
    run: async () => {
      const deleted = await pruneOldRecommendations();
      if (deleted > 0) log.info("audit-log", "prune.done", { deleted });
    },
  });
}

let cronsRegistered = false;

export function startBackgroundFetcher() {
  if (!cronsRegistered) {
    registerCrons();
    cronsRegistered = true;
  }
  log.info("fetcher", "start", {
    refreshIntervalMs: FETCHER_CONFIG.refreshIntervalMs,
    discoveryIntervalMs: FETCHER_CONFIG.discoveryIntervalMs,
    earningsRefreshMs: EARNINGS_CONFIG.refreshIntervalMs,
  });
  startAll();
}

export function stopBackgroundFetcher() {
  stopAll();
  log.info("fetcher", "stop");
}

export function getFetcherStatus() {
  return {
    isRunning,
    lastRunAt,
    lastCompletedAt,
    intervalMs: FETCHER_CONFIG.refreshIntervalMs,
  };
}
