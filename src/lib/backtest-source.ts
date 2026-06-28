// Phase 15b — backtest source layer (edge orchestration).
//
// The pure `runBacktest` simulator (in backtest.ts) takes pre-loaded
// bars as input. This module bridges it to the DB: loads HistoricalBar
// rows, runs the simulator, persists the run, returns the result.
//
// Kept separate from the pure module so the simulator stays
// trivially testable without DB mocks.

import { db } from "./db";
import type { HistoricalBar } from "@/types";
import {
  runBacktest,
  type BacktestParams,
  type BacktestResult,
  type RunBacktestOptions,
} from "./backtest";
import { log } from "./logger";

/**
 * Load every symbol's HistoricalBar rows from the DB and shape them
 * into the Record the simulator expects.
 *
 * Symbols with zero bars are still included in the keys (mapped to
 * `[]`) so the simulator's "skip if no bars today" logic does the
 * right thing.
 */
export async function loadBarsForSymbols(
  symbols: string[]
): Promise<Record<string, HistoricalBar[]>> {
  const out: Record<string, HistoricalBar[]> = {};
  for (const symbol of symbols) {
    const rows = await db.historicalBar.findMany({
      where: { symbol },
      orderBy: { date: "asc" },
    });
    out[symbol] = rows.map((r) => ({
      date: r.date.toISOString(),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
  }
  return out;
}

export interface RunAndPersistOptions extends RunBacktestOptions {
  /** Load symbols from this list. If omitted, load entire watchlist. */
  symbols?: string[];
}

export interface PersistedBacktestRun {
  runId: string;
  result: BacktestResult;
}

/**
 * Load bars, run the backtest, persist a `BacktestRun` row.
 *
 * Returns both the persisted-row id and the in-memory result so
 * callers (the API route) can stream the result back without an
 * extra DB read.
 */
export async function runAndPersistBacktest(
  params: Omit<BacktestParams, "symbols"> & { symbols?: string[] },
  options: RunBacktestOptions = {}
): Promise<PersistedBacktestRun> {
  // Default to the watchlist when caller doesn't supply symbols.
  let symbols = params.symbols;
  if (!symbols || symbols.length === 0) {
    const watchlist = await db.watchlistStock.findMany({
      select: { symbol: true },
    });
    symbols = watchlist.map((w) => w.symbol);
  }

  log.info("backtest", "run.start", {
    symbolCount: symbols.length,
    startDate: params.startDate,
    endDate: params.endDate,
  });

  const startedAt = new Date();
  const barsBySymbol = await loadBarsForSymbols(symbols);

  const fullParams: BacktestParams = {
    symbols,
    startDate: params.startDate,
    endDate: params.endDate,
    startingCapital: params.startingCapital,
  };

  const result = await runBacktest(fullParams, barsBySymbol, options);
  const completedAt = new Date();

  const persisted = await db.backtestRun.create({
    data: {
      paramsJson: JSON.stringify(fullParams),
      resultJson: JSON.stringify(result),
      startedAt,
      completedAt,
    },
  });

  log.info("backtest", "run.done", {
    runId: persisted.id,
    trades: result.summary.tradesCount,
    totalReturnPct: result.summary.totalReturnPct,
  });

  return { runId: persisted.id, result };
}

export interface BacktestRunSummary {
  id: string;
  startedAt: string;
  completedAt: string;
  paramsJson: string;
  /** Lifted out of resultJson for table display without re-parsing. */
  totalReturnPct: number;
  tradesCount: number;
  startDate: string;
  endDate: string;
  startingCapital: number;
  symbolCount: number;
}

/**
 * List previously-stored runs, most-recent first. Lifts a handful of
 * commonly-displayed fields out of resultJson so the runs-list UI
 * doesn't re-parse on every row.
 */
export async function listBacktestRuns(limit = 50): Promise<BacktestRunSummary[]> {
  const rows = await db.backtestRun.findMany({
    orderBy: { startedAt: "desc" },
    take: limit,
  });
  return rows.map((r) => {
    let params: BacktestParams | null = null;
    let result: BacktestResult | null = null;
    try {
      params = JSON.parse(r.paramsJson) as BacktestParams;
    } catch (err) {
      log.warn("backtest", "list.params.parse.failure", {
        runId: r.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      result = JSON.parse(r.resultJson) as BacktestResult;
    } catch (err) {
      log.warn("backtest", "list.result.parse.failure", {
        runId: r.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return {
      id: r.id,
      startedAt: r.startedAt.toISOString(),
      completedAt: r.completedAt.toISOString(),
      paramsJson: r.paramsJson,
      totalReturnPct: result?.summary.totalReturnPct ?? 0,
      tradesCount: result?.summary.tradesCount ?? 0,
      startDate: params?.startDate ?? "",
      endDate: params?.endDate ?? "",
      startingCapital: params?.startingCapital ?? 0,
      symbolCount: params?.symbols.length ?? 0,
    };
  });
}
