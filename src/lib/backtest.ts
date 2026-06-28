// Phase 15b — walk-forward simulator.
//
// For each trading day D in [startDate, endDate]:
//   1. For every symbol still tradable on D:
//      - Build per-symbol Analysis from bars[0..D] (no lookahead).
//      - If signal = BUY / STRONG BUY and no open position for the
//        symbol and we have cash & under the position cap, queue an
//        entry order for D+1.
//   2. For every open position, check D's bar against stop/target
//      via the execution model (gap-down, intraday-pierce, target).
//      Close trades that hit.
//   3. Execute queued entries on the *next* bar with realistic
//      slippage + spread.
//   4. Record an equity-curve point.
//
// At end-of-window: close all still-open positions at the last bar's
// close (exitReason = "end_of_window"). Return the full result.
//
// Pure-ish: takes pre-loaded bars per symbol so the DB / Yahoo
// dependencies stay in the caller (API route or test). No I/O, no
// clock reads.
//
// **What's measured in v1**: technical-only signals from analyzeStock
// (RSI / Bollinger / MACD / momentum / risk packet). Catalysts,
// insider clusters, regime adjustment, options-IV — none of those
// feed into the backtest because their source data isn't yet
// reconstructable point-in-time. Those land in Phase 15.x augments.

import type { Analysis, HistoricalBar } from "@/types";
import { analyzeStock } from "./analysis";
import {
  computeAvgDollarVolume,
  computeSpread,
  simulateMarketBuyFill,
  simulateStopTargetExit,
  type BacktestBar,
} from "./backtest-execution";
import { BACKTEST_CONFIG } from "./config";
import { computePositionSize } from "./position-sizing";
import { log } from "./logger";

export interface BacktestParams {
  symbols: string[];
  /** Inclusive ISO date (YYYY-MM-DD) — bars on or after this date trade. */
  startDate: string;
  /** Inclusive ISO date — bars up to and including this date trade. */
  endDate: string;
  startingCapital: number;
}

export interface BacktestTrade {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  shares: number;
  exitReason: "stop" | "target" | "end_of_window";
  pl: number;
  plPct: number;
  /** Technical signal labels active at entry (Analysis.signals). */
  signalsAtEntry: string[];
  /** Composite score at entry (-100..+100). */
  scoreAtEntry: number;
}

export interface EquityPoint {
  date: string;
  cash: number;
  positionValue: number;
  equity: number;
  openPositions: number;
}

export interface BacktestSummary {
  symbolsConsidered: number;
  symbolsWithEnoughHistory: number;
  tradesCount: number;
  winningTrades: number;
  losingTrades: number;
  startingCapital: number;
  endingCapital: number;
  totalReturn: number;
  totalReturnPct: number;
  cashRemaining: number;
}

export interface BacktestResult {
  params: BacktestParams;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  summary: BacktestSummary;
}

export interface BacktestProgressEvent {
  kind: "progress";
  day: number; // 1-indexed
  totalDays: number;
  date: string;
  equity: number;
  openPositions: number;
  tradesClosed: number;
}

export interface RunBacktestOptions {
  /** Fired after every trading day. Throws inside are swallowed. */
  onProgress?: (event: BacktestProgressEvent) => void | Promise<void>;
}

interface OpenPosition {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  shares: number;
  stopPrice: number;
  targetPrice: number;
  signalsAtEntry: string[];
  scoreAtEntry: number;
}

/**
 * Determine the trading-date union across all symbols, restricted to
 * [startDate, endDate]. Returns sorted unique ISO YYYY-MM-DD strings.
 */
function collectTradingDates(
  barsBySymbol: Record<string, HistoricalBar[]>,
  startDate: string,
  endDate: string
): string[] {
  const dates = new Set<string>();
  for (const bars of Object.values(barsBySymbol)) {
    for (const b of bars) {
      // HistoricalBar.date is ISO; slice to YYYY-MM-DD for comparison.
      const d = b.date.slice(0, 10);
      if (d >= startDate && d <= endDate) dates.add(d);
    }
  }
  return Array.from(dates).sort();
}

/** Convert a HistoricalBar to the execution-model's BacktestBar shape. */
function toBacktestBar(b: HistoricalBar): BacktestBar {
  return {
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  };
}

/**
 * Build an index for each symbol: dateString → bar-array index. Lets
 * the inner loop do O(1) "is symbol tradable on day D" lookups.
 */
function buildDateIndex(
  barsBySymbol: Record<string, HistoricalBar[]>
): Map<string, Map<string, number>> {
  const index = new Map<string, Map<string, number>>();
  for (const [symbol, bars] of Object.entries(barsBySymbol)) {
    const inner = new Map<string, number>();
    bars.forEach((b, i) => {
      inner.set(b.date.slice(0, 10), i);
    });
    index.set(symbol, inner);
  }
  return index;
}

const BUY_RECS = new Set<Analysis["recommendation"]>(["BUY", "STRONG BUY"]);

/**
 * Run a walk-forward backtest.
 *
 * Inputs:
 *   - `params`: symbols, date range, starting capital.
 *   - `barsBySymbol`: pre-loaded HistoricalBar[] for each symbol.
 *     Caller is responsible for the DB read; this function is pure
 *     over the input bar set.
 *   - `options.onProgress`: optional per-day callback.
 *
 * Returns: BacktestResult with trades, equity curve, summary.
 */
export async function runBacktest(
  params: BacktestParams,
  barsBySymbol: Record<string, HistoricalBar[]>,
  options: RunBacktestOptions = {}
): Promise<BacktestResult> {
  const { symbols, startDate, endDate, startingCapital } = params;
  const dateIndex = buildDateIndex(barsBySymbol);
  const tradingDates = collectTradingDates(barsBySymbol, startDate, endDate);

  const symbolsWithEnoughHistory = symbols.filter(
    (s) => (barsBySymbol[s]?.length ?? 0) >= BACKTEST_CONFIG.warmupBars
  ).length;

  let cash = startingCapital;
  const openPositions = new Map<string, OpenPosition>();
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];

  // Queued entries — built on day D from a BUY signal, executed on D+1.
  // Map keeps per-symbol uniqueness: never two queued entries for one symbol.
  interface QueuedEntry {
    symbol: string;
    stopPrice: number;
    targetPrice: number;
    signalsAtEntry: string[];
    scoreAtEntry: number;
  }
  let pendingEntries: QueuedEntry[] = [];

  for (let dayIdx = 0; dayIdx < tradingDates.length; dayIdx++) {
    const currentDate = tradingDates[dayIdx];
    let tradesClosedToday = 0;

    // ── 1. Execute queued entries from the previous day on TODAY's bar.
    if (pendingEntries.length > 0) {
      for (const entry of pendingEntries) {
        const barIdx = dateIndex.get(entry.symbol)?.get(currentDate);
        if (barIdx === undefined) {
          // Symbol has no bar today — skip the entry (we don't carry
          // pending entries forward; this matches live behaviour where
          // a missed open is a missed trade).
          continue;
        }
        const bars = barsBySymbol[entry.symbol];
        const bar = bars[barIdx];
        const recentBars = bars.slice(
          Math.max(0, barIdx - BACKTEST_CONFIG.avgVolumeLookbackBars + 1),
          barIdx + 1
        );
        const adv = computeAvgDollarVolume(
          recentBars.map(toBacktestBar),
          BACKTEST_CONFIG.avgVolumeLookbackBars
        );
        const spreadPct = computeSpread(adv);
        const fillPrice = simulateMarketBuyFill({
          bar: toBacktestBar(bar),
          spreadPct,
        });
        const size = computePositionSize({
          portfolioValueUsd: cash,
          entry: fillPrice,
          stop: entry.stopPrice,
        });
        if (!size || size.dollarValue > cash) continue;
        if (openPositions.size >= BACKTEST_CONFIG.maxOpenPositions) continue;
        cash -= size.dollarValue;
        openPositions.set(entry.symbol, {
          symbol: entry.symbol,
          entryDate: currentDate,
          entryPrice: fillPrice,
          shares: size.shares,
          stopPrice: entry.stopPrice,
          targetPrice: entry.targetPrice,
          signalsAtEntry: entry.signalsAtEntry,
          scoreAtEntry: entry.scoreAtEntry,
        });
      }
      pendingEntries = [];
    }

    // ── 2. Check stop/target for every open position against TODAY's bar.
    for (const [symbol, pos] of Array.from(openPositions.entries())) {
      const barIdx = dateIndex.get(symbol)?.get(currentDate);
      if (barIdx === undefined) continue; // no bar today (halt/delisting)
      const bars = barsBySymbol[symbol];
      const bar = bars[barIdx];
      const recentBars = bars.slice(
        Math.max(0, barIdx - BACKTEST_CONFIG.avgVolumeLookbackBars + 1),
        barIdx + 1
      );
      const adv = computeAvgDollarVolume(
        recentBars.map(toBacktestBar),
        BACKTEST_CONFIG.avgVolumeLookbackBars
      );
      const spreadPct = computeSpread(adv);
      const exit = simulateStopTargetExit({
        bar: toBacktestBar(bar),
        stopPrice: pos.stopPrice,
        targetPrice: pos.targetPrice,
        spreadPct,
      });
      if (exit.reason && exit.price !== null) {
        cash += exit.price * pos.shares;
        const pl = (exit.price - pos.entryPrice) * pos.shares;
        trades.push({
          symbol,
          entryDate: pos.entryDate,
          entryPrice: pos.entryPrice,
          exitDate: currentDate,
          exitPrice: exit.price,
          shares: pos.shares,
          exitReason: exit.reason,
          pl,
          plPct: ((exit.price - pos.entryPrice) / pos.entryPrice) * 100,
          signalsAtEntry: pos.signalsAtEntry,
          scoreAtEntry: pos.scoreAtEntry,
        });
        openPositions.delete(symbol);
        tradesClosedToday += 1;
      }
    }

    // ── 3. Generate new entry signals for D+1 from TODAY's data.
    //     We only queue entries when there's a slot to fill (cash + cap).
    for (const symbol of symbols) {
      if (openPositions.has(symbol)) continue;
      if (openPositions.size + pendingEntries.length >= BACKTEST_CONFIG.maxOpenPositions) break;
      const barIdx = dateIndex.get(symbol)?.get(currentDate);
      if (barIdx === undefined) continue;
      if (barIdx + 1 < BACKTEST_CONFIG.warmupBars) continue; // need warmup history
      const bars = barsBySymbol[symbol];
      const slice = bars.slice(0, barIdx + 1);
      const analysis = analyzeStock(symbol, slice);
      if (
        !BUY_RECS.has(analysis.recommendation) ||
        !analysis.risk ||
        analysis.risk.stop <= 0 ||
        analysis.risk.target <= analysis.risk.entry
      ) {
        continue;
      }
      pendingEntries.push({
        symbol,
        stopPrice: analysis.risk.stop,
        targetPrice: analysis.risk.target,
        signalsAtEntry: analysis.signals.map((s) => s.label),
        scoreAtEntry: analysis.compositeScore,
      });
    }

    // ── 4. Compute today's equity-curve point.
    let positionValue = 0;
    for (const [symbol, pos] of openPositions) {
      const barIdx = dateIndex.get(symbol)?.get(currentDate);
      if (barIdx !== undefined) {
        positionValue += barsBySymbol[symbol][barIdx].close * pos.shares;
      } else {
        // No bar today — mark to last known close conservatively.
        positionValue += pos.entryPrice * pos.shares;
      }
    }
    const equity = cash + positionValue;
    equityCurve.push({
      date: currentDate,
      cash,
      positionValue,
      equity,
      openPositions: openPositions.size,
    });

    if (options.onProgress) {
      try {
        await options.onProgress({
          kind: "progress",
          day: dayIdx + 1,
          totalDays: tradingDates.length,
          date: currentDate,
          equity,
          openPositions: openPositions.size,
          tradesClosed: trades.length,
        });
      } catch (err) {
        log.warn("backtest", "onProgress.callback.failure", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    void tradesClosedToday; // counter used only inside the loop
  }

  // ── End-of-window: close any still-open positions at the last close.
  if (tradingDates.length > 0 && openPositions.size > 0) {
    const lastDate = tradingDates[tradingDates.length - 1];
    for (const [symbol, pos] of Array.from(openPositions.entries())) {
      const barIdx = dateIndex.get(symbol)?.get(lastDate);
      const exitPrice =
        barIdx !== undefined
          ? barsBySymbol[symbol][barIdx].close
          : pos.entryPrice;
      cash += exitPrice * pos.shares;
      trades.push({
        symbol,
        entryDate: pos.entryDate,
        entryPrice: pos.entryPrice,
        exitDate: lastDate,
        exitPrice,
        shares: pos.shares,
        exitReason: "end_of_window",
        pl: (exitPrice - pos.entryPrice) * pos.shares,
        plPct: ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100,
        signalsAtEntry: pos.signalsAtEntry,
        scoreAtEntry: pos.scoreAtEntry,
      });
      openPositions.delete(symbol);
    }
  }

  const winningTrades = trades.filter((t) => t.pl > 0).length;
  const losingTrades = trades.filter((t) => t.pl < 0).length;
  const summary: BacktestSummary = {
    symbolsConsidered: symbols.length,
    symbolsWithEnoughHistory,
    tradesCount: trades.length,
    winningTrades,
    losingTrades,
    startingCapital,
    endingCapital: cash,
    totalReturn: cash - startingCapital,
    totalReturnPct: ((cash - startingCapital) / startingCapital) * 100,
    cashRemaining: cash,
  };

  return {
    params,
    trades,
    equityCurve,
    summary,
  };
}
