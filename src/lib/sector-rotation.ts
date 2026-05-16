// Phase 7.1 — sector rotation (pure module).
//
// Per CLAUDE.md "Pure core, side effects at edges": only deterministic
// math here. The edge module (`./sector-rotation-source.ts`) owns Yahoo
// reads and DB writes.
//
// Goal: detect when a sector ETF has *recently emerged* from an extended
// downtrend — that's the catalyst window. Stocks in sectors merely already
// trending up don't get the bullish nudge (the catalyst has already
// played out); stocks in newly-recovering sectors do.
//
// Classification compares each bar's close to its trailing 200-day SMA:
//
//          ─── above SMA200 ────────  ─── above SMA200 ────
//   below SMA200 ↑↑↑ cross    →  short run above    →  long run above
//                = candidate window     = turning_up        = trending_up
//
// The same idea mirrored gives `turning_down` and `trending_down`. `flat`
// is the "neither" case (run too short to call either way).

import type {
  HistoricalBar,
  SectorRotationInfo,
  SectorRotationState,
} from "@/types";
import {
  SECTOR_ROTATION_CONFIG,
  type SectorRotationConfig,
} from "./config";

/** Simple moving average for the last `period` values; returns NaN when short. */
function sma(values: number[], period: number, endIndex: number): number {
  if (endIndex + 1 < period) return Number.NaN;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) sum += values[i];
  return sum / period;
}

/**
 * Count how many *most-recent* bars satisfy a predicate (working
 * backwards from the end of the series). Used to measure run lengths
 * above/below SMA200.
 */
function trailingRunLength(
  bars: HistoricalBar[],
  predicate: (close: number, sma: number) => boolean,
  smaPeriod: number
): number {
  if (bars.length === 0) return 0;
  const closes = bars.map((b) => b.close);
  let count = 0;
  for (let i = closes.length - 1; i >= 0; i--) {
    const s = sma(closes, smaPeriod, i);
    if (Number.isNaN(s)) break; // not enough history to evaluate
    if (predicate(closes[i], s)) count++;
    else break;
  }
  return count;
}

/**
 * Walking backwards from `startIndex`, count how many consecutive bars
 * satisfy `predicate` before the streak breaks. Used to find the
 * prior-trend run length immediately before today's run.
 */
function priorRunLength(
  bars: HistoricalBar[],
  startIndex: number,
  predicate: (close: number, sma: number) => boolean,
  smaPeriod: number
): number {
  const closes = bars.map((b) => b.close);
  let count = 0;
  for (let i = startIndex; i >= 0; i--) {
    const s = sma(closes, smaPeriod, i);
    if (Number.isNaN(s)) break;
    if (predicate(closes[i], s)) count++;
    else break;
  }
  return count;
}

const isAbove = (c: number, s: number) => c > s;
const isBelow = (c: number, s: number) => c < s;

/**
 * Classify the rotation state of an ETF. Pure: same input → same output.
 *
 * Returns null when there isn't enough history to compute SMA200.
 * Callers (the source module + tests) handle that explicitly.
 */
export interface SectorRotationClassification {
  state: SectorRotationState;
  /** Length of the current run on the *same* side of SMA200 as today's close. */
  recentRunBars: number;
  /** Length of the opposite-side run immediately before the current one. 0 when not applicable. */
  priorOppositeRunBars: number;
  close: number;
  sma200: number;
}

export function classifySectorRotation(
  bars: HistoricalBar[],
  cfg: SectorRotationConfig = SECTOR_ROTATION_CONFIG
): SectorRotationClassification | null {
  if (bars.length < cfg.smaPeriod) return null;

  const closes = bars.map((b) => b.close);
  const lastIdx = closes.length - 1;
  const close = closes[lastIdx];
  const sma200 = sma(closes, cfg.smaPeriod, lastIdx);
  if (Number.isNaN(sma200)) return null;

  const currentlyAbove = close > sma200;
  const sameSide = currentlyAbove ? isAbove : isBelow;
  const oppositeSide = currentlyAbove ? isBelow : isAbove;

  // 1. How long has the ETF been on the current side?
  const recentRunBars = trailingRunLength(bars, sameSide, cfg.smaPeriod);
  // 2. The bar where the cross happened (one past the current run).
  const crossIdx = lastIdx - recentRunBars;
  // 3. How long was it on the opposite side immediately before the cross?
  const priorOppositeRunBars =
    crossIdx >= 0
      ? priorRunLength(bars, crossIdx, oppositeSide, cfg.smaPeriod)
      : 0;

  // Decision: a "turning" state requires a fresh enough cross AND a long
  // enough prior trend. Otherwise: trending (long current run) or flat
  // (short current run without a long prior).
  const maxRecent = currentlyAbove ? cfg.maxRecentUpBars : cfg.maxRecentDownBars;
  const minPrior = currentlyAbove ? cfg.minPriorDownBars : cfg.minPriorUpBars;

  let state: SectorRotationState;
  if (recentRunBars <= maxRecent && priorOppositeRunBars >= minPrior) {
    state = currentlyAbove ? "turning_up" : "turning_down";
  } else if (recentRunBars > maxRecent) {
    state = currentlyAbove ? "trending_up" : "trending_down";
  } else {
    state = "flat";
  }

  return { state, recentRunBars, priorOppositeRunBars, close, sma200 };
}

/**
 * Decorate an analysis-like input with sector rotation. Pure: returns a
 * new object with `sectorRotation` filled in (or unchanged when no info
 * is available for the symbol's sector).
 */
export function attachSectorRotation<T extends object>(
  analysis: T,
  info: SectorRotationInfo | null
): T & { sectorRotation?: SectorRotationInfo } {
  // `sectorRotation?` is optional, so a T without it satisfies the
  // intersection shape — but TS can't verify that automatically.
  if (!info) return analysis as T & { sectorRotation?: SectorRotationInfo };
  return { ...analysis, sectorRotation: info };
}
