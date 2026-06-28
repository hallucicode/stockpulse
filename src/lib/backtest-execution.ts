// Phase 15b — backtest execution model (pure).
//
// "Realistic execution" is what separates a useful backtest from a
// misleading one. Most retail backtests skip slippage, spread, and
// gap-through-stop modelling — the result overstates returns by
// 30-50% on tight-stop strategies. This module owns the math for the
// three biggest distortions:
//
//   - Bid-ask spread (modelled from avg dollar volume — Yahoo doesn't
//     serve bid/ask)
//   - Entry slippage (market order takes the worst price in the bar)
//   - Stop-fill realism (stops fill at the worse of trigger or open;
//     gaps through the stop fill at the gap-open price)
//
// All functions are pure: same input → same output, no I/O, no clock,
// no DB. Trivially testable.

import { BACKTEST_CONFIG } from "./config";

export interface BacktestBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Bid-ask spread for a symbol given its trailing average dollar volume.
 *
 * Linear interpolation between the two tiers in BACKTEST_CONFIG:
 *   - ≥ highVolumeDollarThreshold → lowSpreadPct (liquid)
 *   - ≤ lowVolumeDollarThreshold  → highSpreadPct (illiquid)
 *   - in between → linear blend
 *
 * Returned as a fraction (0.0005 = 5 basis points), applied as
 * half-spread on both entry and exit. Caller is expected to apply
 * sign appropriately (entries pay the offer side, exits hit the bid).
 */
export function computeSpread(avgDollarVolume: number): number {
  const {
    highVolumeDollarThreshold: HIGH,
    lowVolumeDollarThreshold: LOW,
    lowSpreadPct: LOW_SPREAD,
    highSpreadPct: HIGH_SPREAD,
  } = BACKTEST_CONFIG;

  if (!Number.isFinite(avgDollarVolume) || avgDollarVolume <= 0) {
    // Defensive: zero / negative / NaN volume → treat as worst-case.
    return HIGH_SPREAD;
  }
  if (avgDollarVolume >= HIGH) return LOW_SPREAD;
  if (avgDollarVolume <= LOW) return HIGH_SPREAD;

  // Linear interpolation: higher volume → tighter spread.
  const t = (avgDollarVolume - LOW) / (HIGH - LOW);
  return HIGH_SPREAD - t * (HIGH_SPREAD - LOW_SPREAD);
}

/**
 * Trailing average dollar volume across the last `lookback` bars.
 *
 * Returns 0 when the series is too short — caller should treat that
 * as worst-case (via computeSpread's defensive branch).
 */
export function computeAvgDollarVolume(
  bars: BacktestBar[],
  lookback: number = BACKTEST_CONFIG.avgVolumeLookbackBars
): number {
  if (bars.length === 0) return 0;
  const slice = bars.slice(-lookback);
  let total = 0;
  for (const b of slice) {
    // Use close × volume — standard proxy. Yahoo's volume is in shares.
    total += b.close * b.volume;
  }
  return total / slice.length;
}

export interface EntryFillInput {
  /** The bar on which the market order is executed (typically D+1). */
  bar: BacktestBar;
  /** Spread fraction returned by computeSpread. */
  spreadPct: number;
}

/**
 * Simulate a market BUY fill on the next bar.
 *
 * The trade hits the offer side, paying:
 *   - The worst price within the bar's range (= the bar high) as a
 *     proxy for "market order during a moment of strength";
 *   - Plus half the modelled spread on top.
 *
 * Returns the actual fill price (always > 0 for sane input).
 */
export function simulateMarketBuyFill(input: EntryFillInput): number {
  const { bar, spreadPct } = input;
  return bar.high * (1 + spreadPct / 2);
}

export type ExitReason = "stop" | "target" | null;

export interface ExitFillInput {
  bar: BacktestBar;
  stopPrice: number;
  targetPrice: number;
  spreadPct: number;
}

export interface ExitFillResult {
  /** Fill price after spread is applied; null when neither stop nor target hits. */
  price: number | null;
  reason: ExitReason;
}

/**
 * Simulate stop/target exit logic for a single bar of an open long.
 *
 * Order of checks (matters for ambiguous bars where both could trigger):
 *
 *   1. **Gap-down through stop** — if the open is already below the
 *      stop, fill at the gap-open price. This is the realistic case
 *      most backtests skip: you can't sell at your stop if the price
 *      already gapped past it.
 *   2. **Intraday stop hit** — low ≤ stop → fill at the stop price.
 *      (Assumes the stop is a stop-market with a tight fill; reality
 *      is slightly worse but harder to model without level-2 data.)
 *   3. **Target hit** — high ≥ target → fill at the target price.
 *   4. **Otherwise** — position stays open.
 *
 * The stop check beats the target check when both look possible in
 * the same bar. That's the **conservative** assumption for backtest
 * honesty: when ambiguous, assume the loss happened.
 *
 * Spread is applied as a downward adjustment on the fill price (we're
 * selling, so we hit the bid side).
 */
export function simulateStopTargetExit(input: ExitFillInput): ExitFillResult {
  const { bar, stopPrice, targetPrice, spreadPct } = input;

  // 1. Gap-down through stop.
  if (bar.open <= stopPrice) {
    return {
      price: bar.open * (1 - spreadPct / 2),
      reason: "stop",
    };
  }

  // 2. Intraday stop hit.
  if (bar.low <= stopPrice) {
    return {
      price: stopPrice * (1 - spreadPct / 2),
      reason: "stop",
    };
  }

  // 3. Target hit.
  if (bar.high >= targetPrice) {
    return {
      price: targetPrice * (1 - spreadPct / 2),
      reason: "target",
    };
  }

  return { price: null, reason: null };
}
