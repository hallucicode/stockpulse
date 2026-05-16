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
import type { Fundamentals } from "@/types";

const FINNHUB_BASE = "https://finnhub.io/api/v1";

// Finnhub `/stock/metric?metric=all` returns a `metric` object with many
// fields; we only read what we need. Field names from Finnhub docs.
interface FinnhubMetricResponse {
  metric?: Record<string, unknown>;
}

type FetchResult =
  | { status: "ok"; data: Fundamentals }
  | { status: "rate_limited" }
  | { status: "error" };

function getApiKey(): string | undefined {
  const k = process.env.FINNHUB_API_KEY;
  return k && k.length > 0 ? k : undefined;
}

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
  symbol: string,
  apiKey: string
): Promise<FetchResult> {
  const url = `${FINNHUB_BASE}/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${apiKey}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    log.warn("fundamentals", "fetch.network-error", { symbol, error: err });
    return { status: "error" };
  }
  if (res.status === 429) {
    log.warn("fundamentals", "fetch.rate-limited", { symbol });
    return { status: "rate_limited" };
  }
  if (!res.ok) {
    log.warn("fundamentals", "fetch.http-error", {
      symbol,
      status: res.status,
      statusText: res.statusText,
    });
    return { status: "error" };
  }
  const data = (await res.json()) as FinnhubMetricResponse;
  return { status: "ok", data: extractFundamentals(data) };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const start = Date.now();
  const apiKey = getApiKey();
  if (!apiKey) {
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

  let succeeded = 0;
  let rateLimited = 0;
  let errored = 0;

  for (let i = 0; i < watchlist.length; i++) {
    const stock = watchlist[i];
    const result = await fetchFundamentalsForSymbol(stock.symbol, apiKey);

    if (result.status === "ok") {
      try {
        await persistFundamentals(stock.symbol, result.data);
        succeeded++;
      } catch (err) {
        log.warn("fundamentals", "persist.failure", {
          symbol: stock.symbol,
          error: err,
        });
        errored++;
      }
    } else if (result.status === "rate_limited") {
      rateLimited++;
      log.warn("fundamentals", "rate-limit.backoff", {
        symbol: stock.symbol,
        backoffMs: FUNDAMENTALS_CONFIG.rateLimitBackoffMs,
      });
      await sleep(FUNDAMENTALS_CONFIG.rateLimitBackoffMs);
    } else {
      errored++;
    }

    const processed = i + 1;
    if (processed % FUNDAMENTALS_CONFIG.progressLogEveryN === 0) {
      log.info("fundamentals", "refresh.progress", {
        processed,
        total: watchlist.length,
        succeeded,
        rateLimited,
        errored,
      });
    }
    if (i < watchlist.length - 1) {
      await sleep(FUNDAMENTALS_CONFIG.requestSpacingMs);
    }
  }

  const duration = Date.now() - start;
  log.info("fundamentals", "refresh.done", {
    succeeded,
    rateLimited,
    errored,
    total: watchlist.length,
    durationMs: duration,
  });
  return { total: watchlist.length, succeeded, rateLimited, errored, duration };
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
