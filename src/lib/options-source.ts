// Phase 8 — options source (edge module).
//
// I/O lives here; the pure math (ATM picking, IV rank, score adjustment)
// is in `./options.ts`. Uses yahoo-finance2 (already in our stack — no
// new auth, no paid tier). Yahoo's free options endpoint returns the
// nearest expiry's full chain in a single call, which is enough for our
// front-month ATM IV + unusual-flow detection.
//
// Throttling: yahoo isn't formally rate-limited, but bursts get
// throttled with HTTP 429. Same conservative 1.1s serial spacing used
// for news/fundamentals keeps us well below any practical cap.

import YahooFinance from "yahoo-finance2";
import { db } from "./db";
import { log } from "./logger";
import { OPTIONS_CONFIG, type OptionsConfig } from "./config";
import {
  calcIVRank,
  computeOptionsScoreAdjustment,
  evaluateOptionsActivity,
  type OptionsChainSlice,
} from "./options";
import type { OptionsActivity } from "@/types";

const yf = new YahooFinance();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch the nearest-expiry chain slice for a symbol via yahoo-finance2.
 * Returns null when the symbol has no options listed or the chain is
 * empty — that's an expected state for many tickers (microcaps, OTC,
 * non-US listings) and should not be treated as an error.
 */
/**
 * Documented external boundary (per CLAUDE.md): yahoo-finance2's `options()`
 * has multiple typescript overloads (validate-true / validate-false) and TS
 * can pick the `unknown` one in some inference paths. We capture exactly the
 * fields we depend on here so the rest of the module stays strongly typed.
 */
interface YahooOptionsResult {
  quote?: { regularMarketPrice?: number };
  options?: Array<{
    calls: Array<{
      strike: number;
      volume?: number;
      openInterest?: number;
      impliedVolatility: number;
    }>;
    puts: Array<{
      strike: number;
      volume?: number;
      openInterest?: number;
      impliedVolatility: number;
    }>;
  }>;
}

async function fetchChainSlice(symbol: string): Promise<OptionsChainSlice | null> {
  let result: YahooOptionsResult;
  try {
    result = (await yf.options(symbol)) as YahooOptionsResult;
  } catch (err) {
    // Yahoo throws on tickers without options; treat as "no chain".
    log.warn("options", "fetch.no-chain", { symbol, error: err });
    return null;
  }
  if (
    !result ||
    !result.quote ||
    !result.options ||
    result.options.length === 0
  ) {
    return null;
  }
  const underlying = result.quote.regularMarketPrice;
  if (underlying === undefined || !Number.isFinite(underlying) || underlying <= 0) {
    return null;
  }
  const nearest = result.options[0];
  return {
    underlyingPrice: underlying,
    calls: nearest.calls.map((c) => ({
      strike: c.strike,
      volume: c.volume ?? 0,
      openInterest: c.openInterest ?? 0,
      impliedVolatility: c.impliedVolatility,
    })),
    puts: nearest.puts.map((p) => ({
      strike: p.strike,
      volume: p.volume ?? 0,
      openInterest: p.openInterest ?? 0,
      impliedVolatility: p.impliedVolatility,
    })),
  };
}

/**
 * Read the trailing-window historical ATM IV series for one symbol.
 * Returns an empty array on cold start so `calcIVRank` cleanly degrades
 * to null (no rank fired) until enough snapshots accumulate.
 */
export async function getHistoricalIVForSymbol(
  symbol: string,
  cfg: OptionsConfig = OPTIONS_CONFIG
): Promise<number[]> {
  const cutoff = new Date(Date.now() - cfg.ivRankWindowDays * 86_400_000);
  const rows = await db.optionsSnapshot.findMany({
    where: { symbol, fetchedAt: { gte: cutoff }, atmIV: { not: null } },
    orderBy: { fetchedAt: "asc" },
    select: { atmIV: true },
  });
  return rows
    .map((r) => r.atmIV)
    .filter((v): v is number => v !== null && Number.isFinite(v));
}

/**
 * Refresh one symbol: fetch chain, evaluate, persist a snapshot. Returns
 * the OptionsActivity (or null when the symbol has no options). Errors
 * are non-fatal — they're logged and the function returns null.
 */
export async function refreshOptionsForSymbol(
  symbol: string
): Promise<OptionsActivity | null> {
  const slice = await fetchChainSlice(symbol);
  if (slice === null) return null;

  const history = await getHistoricalIVForSymbol(symbol);
  const activity = evaluateOptionsActivity(slice, history);

  try {
    await db.optionsSnapshot.create({
      data: {
        symbol,
        atmIV: activity.atmIV,
        putCallRatio: activity.putCallRatio,
        skew: activity.skew,
        unusualCalls: activity.unusualCalls,
        unusualPuts: activity.unusualPuts,
        callVolume: activity.callVolume,
        putVolume: activity.putVolume,
        callOpenInterest: activity.callOpenInterest,
        putOpenInterest: activity.putOpenInterest,
      },
    });
  } catch (err) {
    log.warn("options", "persist.failure", { symbol, error: err });
  }
  return activity;
}

/**
 * Daily refresh across the watchlist. Serial, with a small spacing
 * between requests so a 600-stock universe takes ~11 minutes rather
 * than 11 seconds — keeps us comfortably under Yahoo's burst limits.
 */
export async function refreshAllOptions(): Promise<{
  total: number;
  succeeded: number;
  skipped: number;
  errored: number;
  duration: number;
}> {
  const start = Date.now();
  const watchlist = await db.watchlistStock.findMany({
    orderBy: { addedAt: "asc" },
  });
  log.info("options", "refresh.start", { count: watchlist.length });

  let succeeded = 0;
  let skipped = 0;
  let errored = 0;

  for (let i = 0; i < watchlist.length; i++) {
    const stock = watchlist[i];
    try {
      const activity = await refreshOptionsForSymbol(stock.symbol);
      if (activity === null) skipped++;
      else succeeded++;
    } catch (err) {
      log.warn("options", "refresh.symbol-error", { symbol: stock.symbol, error: err });
      errored++;
    }

    const processed = i + 1;
    if (processed % OPTIONS_CONFIG.progressLogEveryN === 0) {
      log.info("options", "refresh.progress", {
        processed,
        total: watchlist.length,
        succeeded,
        skipped,
        errored,
      });
    }
    if (i < watchlist.length - 1) {
      await sleep(OPTIONS_CONFIG.requestSpacingMs);
    }
  }

  const duration = Date.now() - start;
  log.info("options", "refresh.done", {
    succeeded,
    skipped,
    errored,
    total: watchlist.length,
    durationMs: duration,
  });
  return { total: watchlist.length, succeeded, skipped, errored, duration };
}

/**
 * Read the latest persisted snapshot for the per-stock decoration step.
 * Returns null when no snapshot exists yet (cold start) — analysis
 * simply doesn't get the options decoration that cycle.
 */
export async function getLatestOptionsForSymbol(
  symbol: string
): Promise<OptionsActivity | null> {
  const row = await db.optionsSnapshot.findFirst({
    where: { symbol },
    orderBy: { fetchedAt: "desc" },
  });
  if (!row) return null;
  // Recompute score adjustment from the persisted fields + fresh history,
  // so a rank that was null on the day of snapshot becomes meaningful
  // once enough days have accumulated (without re-fetching the chain).
  const history = await getHistoricalIVForSymbol(symbol);
  // Build a synthetic activity from the row, then ask the pure module
  // to recompute rank + score adjustment.
  const baseAtmIV = row.atmIV;
  const ivRank =
    baseAtmIV !== null ? calcIVRank(baseAtmIV, history) : null;
  const scoreAdjustment = computeOptionsScoreAdjustment({
    ivRank,
    unusualCalls: row.unusualCalls,
    unusualPuts: row.unusualPuts,
  });
  return {
    atmIV: row.atmIV,
    ivRank,
    putCallRatio: row.putCallRatio,
    skew: row.skew,
    unusualCalls: row.unusualCalls,
    unusualPuts: row.unusualPuts,
    callVolume: row.callVolume,
    putVolume: row.putVolume,
    callOpenInterest: row.callOpenInterest,
    putOpenInterest: row.putOpenInterest,
    scoreAdjustment,
  };
}

