// Phase 15a — historical daily-bars source.
//
// Pulls daily OHLCV from Yahoo via `yahoo-finance2`'s `chart()` and
// upserts into the `HistoricalBar` table. Idempotent by
// `(symbol, date)` uniqueness — re-running on the same window updates
// existing rows in place rather than creating duplicates.
//
// Backfill is a manual operation, not a cron. Historical data doesn't
// change retroactively, and the live `BarsCache` from Phase 0 already
// covers recent days. We back-fill once per universe expansion plus an
// occasional gap-fill if Yahoo serves an empty slice.
//
// Defensive on every failure path: network errors, malformed responses,
// individual symbol failures all log + return summary failure counts
// rather than throwing. A backfill that touches 100 symbols and 4 fail
// is reported as "96 succeeded, 4 failed (see /logs)", not a crash.

import YahooFinance from "yahoo-finance2";
import { db } from "./db";
import { log } from "./logger";
import { serialThrottle } from "./throttle";

const yahooFinance = new YahooFinance();

/** Maximum bars per upsert chunk. SQLite handles much more, but 200 is
 *  a comfortable cap to keep the prepared-statement size reasonable and
 *  per-chunk failure scope small. */
const UPSERT_CHUNK_SIZE = 200;

/** Spacing between symbols during a watchlist-wide backfill. Same
 *  cadence we use for analyst / insider serial pulls — well under
 *  Yahoo's effective rate limit. */
const SYMBOL_SPACING_MS = 1100;

export interface BackfillSymbolResult {
  symbol: string;
  /** Bars actually written (after upsert dedupe). */
  barsWritten: number;
  /** True when Yahoo returned an empty quote series (delisted, bad ticker). */
  empty: boolean;
  /** Set when something failed below the throttle layer. */
  error?: string;
}

/**
 * Backfill `symbol` for the last `years` years of daily bars.
 *
 * Returns a `BackfillSymbolResult` describing what happened — never
 * throws. Caller can aggregate results across symbols and surface
 * counts to the UI / logs.
 */
export async function backfillSymbol(
  symbol: string,
  years: number
): Promise<BackfillSymbolResult> {
  const end = new Date();
  const start = new Date();
  start.setFullYear(start.getFullYear() - years);

  let bars: Array<{
    date: Date;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    volume: number | null;
    adjclose?: number | null;
  }>;
  try {
    const result = await yahooFinance.chart(symbol, {
      period1: start,
      period2: end,
      interval: "1d",
    });
    bars = result.quotes ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("historical", "fetch.failure", { symbol, error: message });
    return { symbol, barsWritten: 0, empty: false, error: message };
  }

  if (bars.length === 0) {
    log.info("historical", "fetch.empty", { symbol });
    return { symbol, barsWritten: 0, empty: true };
  }

  // Only keep bars with a full OHLCV — Yahoo occasionally returns
  // partial rows (e.g. nulls during halted sessions) that would
  // produce useless data in the DB.
  const usableBars = bars.filter(
    (b) =>
      b.date instanceof Date &&
      !Number.isNaN(b.date.getTime()) &&
      Number.isFinite(b.open) &&
      Number.isFinite(b.high) &&
      Number.isFinite(b.low) &&
      Number.isFinite(b.close) &&
      Number.isFinite(b.volume)
  );

  let written = 0;
  try {
    for (let i = 0; i < usableBars.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = usableBars.slice(i, i + UPSERT_CHUNK_SIZE);
      await Promise.all(
        chunk.map((b) =>
          db.historicalBar.upsert({
            where: {
              symbol_date: { symbol, date: b.date },
            },
            update: {
              open: b.open as number,
              high: b.high as number,
              low: b.low as number,
              close: b.close as number,
              volume: b.volume as number,
              adjClose:
                typeof b.adjclose === "number" && Number.isFinite(b.adjclose)
                  ? b.adjclose
                  : null,
            },
            create: {
              symbol,
              date: b.date,
              open: b.open as number,
              high: b.high as number,
              low: b.low as number,
              close: b.close as number,
              volume: b.volume as number,
              adjClose:
                typeof b.adjclose === "number" && Number.isFinite(b.adjclose)
                  ? b.adjclose
                  : null,
            },
          })
        )
      );
      written += chunk.length;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("historical", "persist.failure", { symbol, error: message });
    return { symbol, barsWritten: written, empty: false, error: message };
  }

  return { symbol, barsWritten: written, empty: false };
}

export interface BackfillWatchlistSummary {
  totalSymbols: number;
  succeeded: number;
  empty: number;
  errored: number;
  totalBarsWritten: number;
}

/**
 * Backfill every symbol on the watchlist for the last `years` years.
 *
 * Serial with per-symbol spacing (Yahoo doesn't love hundreds of
 * parallel chart requests). Aggregates results into a single summary.
 */
export async function backfillWatchlist(
  years: number
): Promise<BackfillWatchlistSummary> {
  const stocks = await db.watchlistStock.findMany({
    select: { symbol: true },
  });
  log.info("historical", "backfill.start", {
    symbolCount: stocks.length,
    years,
  });

  let totalBarsWritten = 0;
  let succeeded = 0;
  let empty = 0;
  let errored = 0;

  const summary = await serialThrottle({
    items: stocks.map((s) => s.symbol),
    spacingMs: SYMBOL_SPACING_MS,
    run: async (symbol) => {
      const result = await backfillSymbol(symbol, years);
      totalBarsWritten += result.barsWritten;
      if (result.error) {
        errored += 1;
        return { kind: "error" };
      }
      if (result.empty) {
        empty += 1;
        return { kind: "skipped" };
      }
      succeeded += 1;
      return { kind: "ok" };
    },
  });

  log.info("historical", "backfill.done", {
    totalSymbols: summary.total,
    succeeded,
    empty,
    errored,
    totalBarsWritten,
  });

  return {
    totalSymbols: summary.total,
    succeeded,
    empty,
    errored,
    totalBarsWritten,
  };
}

export interface SymbolSummary {
  symbol: string;
  barCount: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Number of gaps > 4 days between consecutive bars (skips weekends + a holiday). */
  gapCount: number;
}

/**
 * Walk the date series for one symbol and count any gap > 4 days
 * between consecutive bars. Pure helper; no I/O.
 *
 * Exported for direct testing.
 */
export function countLargeGaps(dates: Date[]): number {
  if (dates.length < 2) return 0;
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  let gaps = 0;
  for (let i = 1; i < sorted.length; i++) {
    const diffMs = sorted[i].getTime() - sorted[i - 1].getTime();
    const diffDays = diffMs / (24 * 60 * 60 * 1000);
    if (diffDays > 4) gaps += 1;
  }
  return gaps;
}

/**
 * Per-symbol summary view of what's currently in `HistoricalBar`.
 * Drives the `/historical` UI's main table.
 */
export async function listSymbolSummaries(): Promise<SymbolSummary[]> {
  // Watchlist defines the universe; some symbols may have zero bars
  // (never back-filled, or backfill failed). Show all of them so the
  // UI can flag missing data.
  const stocks = await db.watchlistStock.findMany({
    select: { symbol: true },
    orderBy: { symbol: "asc" },
  });

  const summaries: SymbolSummary[] = [];
  for (const { symbol } of stocks) {
    const bars = await db.historicalBar.findMany({
      where: { symbol },
      select: { date: true },
      orderBy: { date: "asc" },
    });
    const dates = bars.map((b) => b.date);
    summaries.push({
      symbol,
      barCount: dates.length,
      firstDate: dates[0]?.toISOString() ?? null,
      lastDate: dates[dates.length - 1]?.toISOString() ?? null,
      gapCount: countLargeGaps(dates),
    });
  }
  return summaries;
}

export interface BarRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Return the full bar series for one symbol, date-ascending. */
export async function getSymbolBars(symbol: string): Promise<BarRow[]> {
  const rows = await db.historicalBar.findMany({
    where: { symbol },
    orderBy: { date: "asc" },
  });
  return rows.map((r) => ({
    date: r.date.toISOString(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
}
