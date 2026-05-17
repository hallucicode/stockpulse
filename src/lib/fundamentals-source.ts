// Phase 4.5 — fundamentals source (edge module).
//
// Per CLAUDE.md "Pure core, side effects at edges": this file owns the I/O
// (HTTP to Finnhub + DB writes). The decision logic ("is this stock
// vetoable?") lives in `./fundamentals.ts` (pure).
//
// Provider: Finnhub free tier. Endpoint:
//   GET /api/v1/stock/metric?symbol=...&metric=all&token=KEY
//
// Same throttling pattern as `news-source.ts`: serial calls with
// per-request spacing chosen to stay under the 60 req/min cap. With ~800
// symbols × 1.1s spacing = ~14 minutes per refresh — acceptable for a
// weekly cadence.
//
// Graceful degradation:
//   - No FINNHUB_API_KEY → log once, skip the cron, no rows persisted.
//   - 429 → backoff, skip the symbol, continue.
//   - 5xx / network → skip the symbol, log, continue.

import { db } from "./db";
import { log } from "./logger";
import { FUNDAMENTALS_CONFIG } from "./config";
import { finnhubFetch, getFinnhubKey } from "./finnhub";
import { serialThrottle, type ThrottleStepResult } from "./throttle";
import type { Fundamentals } from "@/types";

// Finnhub `/stock/metric?metric=all` returns a `metric` object with many
// fields; we only read what we need. Field names from Finnhub docs.
interface FinnhubMetricResponse {
  metric?: Record<string, unknown>;
}

type FetchResult =
  | { status: "ok"; data: Fundamentals }
  | { status: "rate_limited" }
  | { status: "error" };

function pickNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Map Finnhub's raw metric blob to our internal `Fundamentals` shape.
 * Defensive — every field is nullable; we never crash on a missing key.
 *
 * `marketCapitalization` from Finnhub is in **millions of USD**; we
 * normalise to absolute USD on ingest so downstream comparisons match the
 * config thresholds (which are in absolute USD).
 */
export function extractFundamentals(
  raw: FinnhubMetricResponse
): Fundamentals {
  const m: Record<string, unknown> = raw?.metric ?? {};
  const mcMillions = pickNumber(m["marketCapitalization"]);
  const marketCap = mcMillions !== null ? mcMillions * 1_000_000 : null;
  const epsTtm = pickNumber(m["epsTTM"]);
  return {
    marketCap,
    peRatio: pickNumber(m["peTTM"]),
    debtToEquity: pickNumber(m["totalDebt/totalEquityAnnual"]),
    freeCashFlowTtm: pickNumber(m["freeCashFlowTTM"]),
    epsTtm,
    revenueGrowthYoy: pickNumber(m["revenueGrowthTTMYoy"]),
    hasReportedEarnings: epsTtm !== null,
  };
}

async function fetchFundamentalsForSymbol(
  symbol: string
): Promise<FetchResult> {
  const result = await finnhubFetch<FinnhubMetricResponse>(
    "/stock/metric",
    { symbol, metric: "all" }
  );
  switch (result.status) {
    case "no_key":
      log.warn("fundamentals", "fetch.no-key-mid-loop", { symbol });
      return { status: "error" };
    case "rate_limited":
      log.warn("fundamentals", "fetch.rate-limited", { symbol });
      return { status: "rate_limited" };
    case "error":
      log.warn("fundamentals", "fetch.error", { symbol, error: result.error });
      return { status: "error" };
    case "ok":
      return { status: "ok", data: extractFundamentals(result.data) };
  }
}

async function persistFundamentals(
  symbol: string,
  f: Fundamentals
): Promise<void> {
  await db.fundamentalsSnapshot.upsert({
    where: { symbol },
    update: { ...f, fetchedAt: new Date() },
    create: { symbol, ...f },
  });
}

/**
 * Walk the watchlist and refresh fundamentals for each, strictly serially.
 * Same shape as `refreshNewsForWatchlist` — the rate-limit budget is the
 * same and we share the watchlist iteration pattern.
 */
export async function refreshAllFundamentals(): Promise<{
  total: number;
  succeeded: number;
  rateLimited: number;
  errored: number;
  duration: number;
}> {
  if (!getFinnhubKey()) {
    log.info("fundamentals", "refresh.skip.no-key");
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
  log.info("fundamentals", "refresh.start", { count: watchlist.length });

  const summary = await serialThrottle({
    items: watchlist,
    spacingMs: FUNDAMENTALS_CONFIG.requestSpacingMs,
    rateLimitBackoffMs: FUNDAMENTALS_CONFIG.rateLimitBackoffMs,
    progressEveryN: FUNDAMENTALS_CONFIG.progressLogEveryN,
    onProgress: (p) => log.info("fundamentals", "refresh.progress", p),
    run: async (stock): Promise<ThrottleStepResult> => {
      const result = await fetchFundamentalsForSymbol(stock.symbol);
      if (result.status === "rate_limited") {
        log.warn("fundamentals", "rate-limit.backoff", {
          symbol: stock.symbol,
          backoffMs: FUNDAMENTALS_CONFIG.rateLimitBackoffMs,
        });
        return { kind: "rate_limited" };
      }
      if (result.status === "error") return { kind: "error" };
      try {
        await persistFundamentals(stock.symbol, result.data);
        return { kind: "ok" };
      } catch (err) {
        log.warn("fundamentals", "persist.failure", {
          symbol: stock.symbol,
          error: err,
        });
        return { kind: "error" };
      }
    },
  });

  log.info("fundamentals", "refresh.done", {
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
 * DB-cached read used by the per-stock decoration step in background-fetcher.
 * Returns null when the symbol has never been fetched (cold start);
 * orchestrator treats null as "skip the veto" (don't penalise tickers we
 * just haven't tried yet).
 */
export async function getFundamentalsForSymbol(
  symbol: string
): Promise<Fundamentals | null> {
  const row = await db.fundamentalsSnapshot.findUnique({ where: { symbol } });
  if (!row) return null;
  return {
    marketCap: row.marketCap,
    peRatio: row.peRatio,
    debtToEquity: row.debtToEquity,
    freeCashFlowTtm: row.freeCashFlowTtm,
    epsTtm: row.epsTtm,
    revenueGrowthYoy: row.revenueGrowthYoy,
    hasReportedEarnings: row.hasReportedEarnings,
  };
}
