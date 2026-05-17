// Phase 4 — news source (edge module).
//
// Per CLAUDE.md "Pure core, side effects at edges": this file owns the I/O
// (HTTP to Finnhub + DB writes). All classification logic lives in
// `./diagnosis.ts` (pure).
//
// Provider: Finnhub free tier. Endpoint:
//   GET /api/v1/company-news?symbol=...&from=YYYY-MM-DD&to=YYYY-MM-DD&token=KEY
//
// Graceful degradation:
//   - No API key → log once per cycle and skip. Analyses get no `diagnosis`
//     field. UI hides the badge. Same pattern as earnings-source.ts.
//   - Network failure → logged via log.warn/error; next cycle retries.
//   - Per-symbol failure → logged; refresh continues for the rest.

import { createHash } from "node:crypto";
import { db } from "./db";
import { log } from "./logger";
import { NEWS_CONFIG } from "./config";
import { diagnoseFromNews } from "./diagnosis";
import { finnhubFetch, getFinnhubKey } from "./finnhub";
import { serialThrottle, type ThrottleStepResult } from "./throttle";
import type { DiagnosisInfo } from "@/types";

// Finnhub `/company-news` row shape. Subset we use.
interface FinnhubNewsRow {
  id: number; // numeric id, used as our `externalId`
  category: string;
  datetime: number; // unix seconds
  headline: string;
  image?: string;
  related?: string;
  source: string;
  summary: string;
  url: string;
}

function isoDay(d: Date): string {
  return d.toISOString().split("T")[0];
}

// Discriminated result so the caller can distinguish "API said no news"
// (status=ok) from "API rate-limited us" (status=rate_limited) from "API
// failed for some other reason" (status=error). Used internally by
// `refreshNewsForWatchlist` to drive serialThrottle's outcome counts.
type FetchResult =
  | { status: "ok"; rows: FinnhubNewsRow[] }
  | { status: "rate_limited" }
  | { status: "error" };

async function fetchNewsForSymbol(symbol: string): Promise<FetchResult> {
  const to = new Date();
  const from = new Date(to.getTime() - NEWS_CONFIG.lookbackDays * 86_400_000);
  const result = await finnhubFetch<FinnhubNewsRow[]>("/company-news", {
    symbol,
    from: isoDay(from),
    to: isoDay(to),
  });
  switch (result.status) {
    case "no_key":
      // Should never happen here — the caller already checks getFinnhubKey
      // before entering the loop. Treat as error if it does (defensive).
      log.warn("news", "fetch.no-key-mid-loop", { symbol });
      return { status: "error" };
    case "rate_limited":
      log.warn("news", "fetch.rate-limited", { symbol });
      return { status: "rate_limited" };
    case "error":
      log.warn("news", "fetch.error", { symbol, error: result.error });
      return { status: "error" };
    case "ok":
      return {
        status: "ok",
        rows: Array.isArray(result.data) ? result.data : [],
      };
  }
}

async function persistNews(
  symbol: string,
  rows: FinnhubNewsRow[]
): Promise<number> {
  let upserted = 0;
  // Cap to maxItemsPerSymbol most recent (Finnhub returns chronological,
  // newest first or last depending on endpoint — be defensive).
  const sorted = rows
    .slice()
    .sort((a, b) => b.datetime - a.datetime)
    .slice(0, NEWS_CONFIG.maxItemsPerSymbol);

  for (const r of sorted) {
    if (!r.id || !r.headline || !r.datetime) continue;
    try {
      await db.newsItem.upsert({
        where: {
          symbol_externalId: { symbol, externalId: String(r.id) },
        },
        update: {
          headline: r.headline,
          summary: r.summary ?? "",
          source: r.source ?? "",
          url: r.url ?? "",
          category: r.category ?? "",
          publishedAt: new Date(r.datetime * 1000),
        },
        create: {
          symbol,
          externalId: String(r.id),
          headline: r.headline,
          summary: r.summary ?? "",
          source: r.source ?? "",
          url: r.url ?? "",
          category: r.category ?? "",
          publishedAt: new Date(r.datetime * 1000),
        },
      });
      upserted++;
    } catch (err) {
      log.warn("news", "upsert.failure", {
        symbol,
        externalId: String(r.id),
        error: err,
      });
    }
  }

  // Trim older rows so the table stays small.
  const cutoff = new Date(
    Date.now() - NEWS_CONFIG.lookbackDays * 86_400_000
  );
  await db.newsItem.deleteMany({
    where: { symbol, publishedAt: { lt: cutoff } },
  });

  return upserted;
}

/**
 * Walk the watchlist and refresh news for each, **strictly serially** with
 * per-request spacing tuned to stay under Finnhub's 60 req/min free-tier
 * limit. ~14 minutes for 800 symbols at 1.1s spacing — slow but predictable
 * and rate-limit-safe.
 *
 * Counts are returned (and logged on `refresh.done`) so the operator can
 * tell at a glance whether the run was healthy:
 *   - `succeeded` = symbols whose API call returned 2xx
 *   - `rateLimited` = symbols that got 429 (back off + skip)
 *   - `errored` = network or non-429 HTTP failures
 */
export async function refreshNewsForWatchlist(): Promise<{
  total: number;
  succeeded: number;
  rateLimited: number;
  errored: number;
  duration: number;
}> {
  if (!getFinnhubKey()) {
    log.info("news", "refresh.skip.no-key");
    return {
      total: 0,
      succeeded: 0,
      rateLimited: 0,
      errored: 0,
      duration: 0,
    };
  }

  const watchlist = await db.watchlistStock.findMany({
    orderBy: { addedAt: "asc" },
  });
  log.info("news", "refresh.start", { count: watchlist.length });

  const summary = await serialThrottle({
    items: watchlist,
    spacingMs: NEWS_CONFIG.requestSpacingMs,
    rateLimitBackoffMs: NEWS_CONFIG.rateLimitBackoffMs,
    progressEveryN: NEWS_CONFIG.progressLogEveryN,
    onProgress: (p) => log.info("news", "refresh.progress", p),
    run: async (stock): Promise<ThrottleStepResult> => {
      const result = await fetchNewsForSymbol(stock.symbol);
      if (result.status === "rate_limited") {
        log.warn("news", "rate-limit.backoff", {
          symbol: stock.symbol,
          backoffMs: NEWS_CONFIG.rateLimitBackoffMs,
        });
        return { kind: "rate_limited" };
      }
      if (result.status === "error") return { kind: "error" };
      try {
        await persistNews(stock.symbol, result.rows);
        return { kind: "ok" };
      } catch (err) {
        // persistNews already logs per-row failures; this is a guard
        // for an unexpected throw at the persistence layer.
        log.warn("news", "persist.failure", {
          symbol: stock.symbol,
          error: err,
        });
        return { kind: "error" };
      }
    },
  });

  log.info("news", "refresh.done", {
    succeeded: summary.succeeded,
    rateLimited: summary.rateLimited,
    errored: summary.errored,
    total: summary.total,
    durationMs: summary.durationMs,
  });
  return {
    total: summary.total,
    succeeded: summary.succeeded,
    rateLimited: summary.rateLimited,
    errored: summary.errored,
    duration: summary.durationMs,
  };
}

/**
 * Hash the headlines list — a stable fingerprint of the diagnosis input.
 * Used to detect when a recompute would produce the same answer so we can
 * short-circuit by reading from `DiagnosisCache`.
 *
 * SHA-1 is fine here — we're hashing for change detection, not security.
 */
function hashHeadlines(headlines: string[]): string {
  const h = createHash("sha1");
  for (const headline of headlines) {
    h.update(headline);
    h.update("\n");
  }
  return h.digest("hex");
}

/**
 * Get the diagnosis for a symbol, using the cache when the underlying
 * headlines haven't changed since the last computation.
 *
 * Returns the same `DiagnosisInfo` shape as the pure `diagnoseFromNews()` —
 * callers can't tell whether it came from the cache or was freshly computed.
 *
 * Best-effort caching: if the cache read or write fails, we fall through to
 * fresh compute and just skip persistence. Diagnosis must never be the
 * thing that breaks the fetcher.
 */
export async function getOrCacheDiagnosis(
  symbol: string,
  headlines: string[]
): Promise<DiagnosisInfo> {
  const newsHash = hashHeadlines(headlines);

  // Cache lookup
  try {
    const hit = await db.diagnosisCache.findUnique({ where: { symbol } });
    if (hit && hit.newsHash === newsHash) {
      return {
        category: hit.category as DiagnosisInfo["category"],
        rationale: hit.rationale,
        newsCount: hit.newsCount,
        scoreAdjustment: hit.scoreAdjustment,
      };
    }
  } catch (err) {
    log.warn("news", "diagnosis-cache.read.failure", { symbol, error: err });
  }

  const fresh = diagnoseFromNews(headlines);

  // Don't poison the cache during cold start. When the news refresh cron
  // hasn't completed yet during the first stock cycle, we'd otherwise
  // persist `technical_only` for every symbol and only fix it 5 min later
  // when the next cycle's hash mismatches. Skipping the write for the
  // empty-headlines case (which is the only situation that produces this
  // exact `technical_only` result) closes the race; recomputing on the
  // next cycle is essentially free.
  if (headlines.length === 0) {
    return fresh;
  }

  // Persist (fire-and-forget tolerant — failures don't break the cycle).
  try {
    await db.diagnosisCache.upsert({
      where: { symbol },
      update: {
        category: fresh.category,
        rationale: fresh.rationale,
        scoreAdjustment: fresh.scoreAdjustment,
        newsCount: fresh.newsCount,
        newsHash,
        fetchedAt: new Date(),
      },
      create: {
        symbol,
        category: fresh.category,
        rationale: fresh.rationale,
        scoreAdjustment: fresh.scoreAdjustment,
        newsCount: fresh.newsCount,
        newsHash,
      },
    });
  } catch (err) {
    log.warn("news", "diagnosis-cache.write.failure", { symbol, error: err });
  }

  return fresh;
}

/**
 * Lightweight health summary used by /api/scanner. Tells the UI whether
 * news data is fresh enough that diagnosis badges should be trusted.
 */
export interface NewsHealth {
  /** ISO of the most recent NewsItem.fetchedAt across all symbols, or null. */
  lastIngestAt: string | null;
  /** Whole hours since the most recent ingest. null when no data ever. */
  ageHours: number | null;
  /** True when stale beyond `staleThresholdHours`. */
  isStale: boolean;
  /** True when the table is empty (no news data at all). */
  isMissing: boolean;
}

export async function getNewsHealth(now: Date = new Date()): Promise<NewsHealth> {
  const agg = await db.newsItem.aggregate({ _max: { fetchedAt: true } });
  const latest = agg._max.fetchedAt;
  if (!latest) {
    return {
      lastIngestAt: null,
      ageHours: null,
      isStale: true,
      isMissing: true,
    };
  }
  const ageMs = now.getTime() - latest.getTime();
  const ageHours = Math.floor(ageMs / 3_600_000);
  return {
    lastIngestAt: latest.toISOString(),
    ageHours,
    isStale: ageHours >= NEWS_CONFIG.staleThresholdHours,
    isMissing: false,
  };
}

/**
 * DB-cached read used by the per-stock decoration step in background-fetcher.
 * Returns the most recent N items, newest first. Pure DB read; no HTTP.
 */
export async function getRecentNewsForSymbol(
  symbol: string
): Promise<{ headline: string; publishedAt: Date }[]> {
  const cutoff = new Date(
    Date.now() - NEWS_CONFIG.diagnosisLookbackDays * 86_400_000
  );
  const rows = await db.newsItem.findMany({
    where: { symbol, publishedAt: { gte: cutoff } },
    orderBy: { publishedAt: "desc" },
    take: NEWS_CONFIG.maxItemsPerSymbol,
    select: { headline: true, publishedAt: true },
  });
  return rows;
}
