// Phase 14 — risk-based position sizing.
//
// Standard "fixed fractional" rule: never lose more than `riskPct` of the
// portfolio if the stop is hit. Shares are sized off the distance from entry
// to stop, not off the entry price — that way a volatile name with a wide
// stop gets a smaller dollar allocation than a tight-stop name, automatically.
//
// All inputs are USD. The portfolio panel converts to EUR for display only;
// sizing math is in the trading currency (USD) so we never lose precision to
// rounding through an FX rate.
//
// Pure module: no I/O, no clock reads, no DB. Trivially testable.

import { RISK_CONFIG } from "./config";

export interface PositionSizingInput {
  /**
   * Total portfolio value in USD (sum of current value of all positions, or
   * RISK_CONFIG.defaultPortfolioValue when the portfolio is empty and the
   * user is still planning their first trade).
   */
  portfolioValueUsd: number;
  /** Entry price per share. */
  entry: number;
  /** Stop-loss price per share. Must be < entry. */
  stop: number;
  /**
   * Fraction of portfolio at risk per trade. Defaults to
   * RISK_CONFIG.riskPerTradePct (0.01 = 1%). Caller can override for
   * what-if calculations.
   */
  riskPct?: number;
  /**
   * Hard cap on any single position as a fraction of the portfolio.
   * Defaults to RISK_CONFIG.maxPositionPct (0.10 = 10%). Prevents one
   * very tight-stop name from eating the whole book.
   */
  maxPositionPct?: number;
}

export interface PositionSize {
  /** Whole-share count. Always >= 1 when returned (0 → null). */
  shares: number;
  /** shares × entry. Useful for the UI label. */
  dollarValue: number;
  /** dollarValue / portfolioValueUsd, as a fraction (0.041 = 4.1%). */
  portfolioPct: number;
  /** Whether the maxPositionPct cap clipped the size. UI can flag it. */
  cappedByPositionLimit: boolean;
}

/**
 * Compute risk-based position sizing.
 *
 * Returns null when the inputs don't permit a meaningful answer:
 *   - portfolio value ≤ 0 (no capital)
 *   - entry ≤ 0 or stop ≤ 0 (degenerate price)
 *   - entry ≤ stop (no risk-defined trade — stop must be below entry)
 *   - non-finite inputs (NaN / Infinity)
 *   - resulting share count rounds down to 0 (entry > risk budget)
 *
 * Failing fast > silently returning 0 shares — the UI should hide the size
 * row rather than display "0 shares ($0)".
 */
export function computePositionSize(
  input: PositionSizingInput
): PositionSize | null {
  const {
    portfolioValueUsd,
    entry,
    stop,
    riskPct = RISK_CONFIG.riskPerTradePct,
    maxPositionPct = RISK_CONFIG.maxPositionPct,
  } = input;

  if (
    !Number.isFinite(portfolioValueUsd) ||
    !Number.isFinite(entry) ||
    !Number.isFinite(stop) ||
    !Number.isFinite(riskPct) ||
    !Number.isFinite(maxPositionPct)
  ) {
    return null;
  }
  if (portfolioValueUsd <= 0) return null;
  if (entry <= 0 || stop <= 0) return null;
  if (entry <= stop) return null;
  if (riskPct <= 0 || maxPositionPct <= 0) return null;

  const riskBudget = portfolioValueUsd * riskPct;
  const perShareRisk = entry - stop;
  const rawShares = riskBudget / perShareRisk;

  // Apply the position-size cap before rounding so the cap kicks in on
  // dollar terms, not on integer-share terms (which would be off by 1 for
  // expensive stocks).
  const maxSharesByPositionCap = (portfolioValueUsd * maxPositionPct) / entry;
  const cappedByPositionLimit = rawShares > maxSharesByPositionCap;
  const sizedShares = cappedByPositionLimit
    ? maxSharesByPositionCap
    : rawShares;

  const shares = Math.floor(sizedShares);
  if (shares < 1) return null;

  const dollarValue = shares * entry;
  const portfolioPct = dollarValue / portfolioValueUsd;

  return {
    shares,
    dollarValue,
    portfolioPct,
    cappedByPositionLimit,
  };
}
