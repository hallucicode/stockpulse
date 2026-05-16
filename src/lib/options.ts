// Phase 8 — options market signals (pure module).
//
// Per CLAUDE.md "Pure core, side effects at edges": all I/O lives in
// `./options-source.ts`. This file only does math: ATM contract picking,
// put/call ratio, skew, IV-rank percentile, unusual-activity heuristic,
// and the score adjustment.
//
// Why this matters: smart money expresses views in options first.
// - IV at the 1-yr low (cheap) = good time to express the view → +5.
// - IV at the 1-yr high (expensive) = move already priced in, vol crush
//   risk → -10.
// - Aggressive unusual call buying (volume >> OI) = bullish flow → +10.
// - Aggressive unusual put buying = bearish flow → -10.

import type {
  Analysis,
  OptionsActivity,
  TechnicalSignal,
} from "@/types";
import { OPTIONS_CONFIG, RECOMMENDATION_THRESHOLDS } from "./config";

/** Subset of the Yahoo CallOrPut we depend on — keeps tests easy to build. */
export interface OptionContract {
  strike: number;
  /** Yahoo returns volume optionally — fall back to 0 when missing. */
  volume?: number;
  openInterest?: number;
  /** Decimal IV from Yahoo (0.35 = 35%). */
  impliedVolatility: number;
}

export interface OptionsChainSlice {
  /** Underlying price (Yahoo `quote.regularMarketPrice`). */
  underlyingPrice: number;
  /** Calls + puts from the *nearest* expiry. We deliberately don't aggregate
   *  across expiries — IV varies meaningfully by tenor and ATM front-month
   *  is the canonical "current IV" reference. */
  calls: OptionContract[];
  puts: OptionContract[];
}

/**
 * Pick the contract whose strike is closest to `underlyingPrice`, subject
 * to the `atmTolerancePct` tolerance. Returns null when no contract sits
 * within tolerance (illiquid names with sparse strikes around spot).
 */
export function pickAtm(
  contracts: OptionContract[],
  underlyingPrice: number,
  cfg: typeof OPTIONS_CONFIG = OPTIONS_CONFIG
): OptionContract | null {
  if (contracts.length === 0) return null;
  const tolerance = underlyingPrice * cfg.atmTolerancePct;
  let best: OptionContract | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of contracts) {
    const d = Math.abs(c.strike - underlyingPrice);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  if (best === null || bestDist > tolerance) return null;
  return best;
}

/** Sum side volume + open interest from a chain slice. */
export function aggregateSides(slice: OptionsChainSlice): {
  callVolume: number;
  putVolume: number;
  callOpenInterest: number;
  putOpenInterest: number;
} {
  const sum = (xs: OptionContract[], key: "volume" | "openInterest") =>
    xs.reduce((acc, c) => acc + (c[key] ?? 0), 0);
  return {
    callVolume: sum(slice.calls, "volume"),
    putVolume: sum(slice.puts, "volume"),
    callOpenInterest: sum(slice.calls, "openInterest"),
    putOpenInterest: sum(slice.puts, "openInterest"),
  };
}

/**
 * Put volume / call volume. Returns null when call volume is zero
 * (rather than ±infinity) — null serialises cleanly and tells the UI
 * "no signal" instead of producing a misleading huge number.
 */
export function putCallRatio(callVol: number, putVol: number): number | null {
  if (callVol <= 0) return null;
  return putVol / callVol;
}

/**
 * Skew = put IV − call IV at the ATM strike. Positive = put side is more
 * expensive (fear premium). Returns null when either ATM strike is missing.
 */
export function calcSkew(
  atmCall: OptionContract | null,
  atmPut: OptionContract | null
): number | null {
  if (!atmCall || !atmPut) return null;
  return atmPut.impliedVolatility - atmCall.impliedVolatility;
}

/**
 * IV rank = percentile of `currentIV` within `historical`. Returns null
 * if there isn't enough history (under `minHistoryDaysForRank`) — better
 * to display "IV: 35%" than "IV: 35% (rank 0)" when rank is bogus.
 */
export function calcIVRank(
  currentIV: number,
  historical: number[],
  cfg: typeof OPTIONS_CONFIG = OPTIONS_CONFIG
): number | null {
  const valid = historical.filter((x) => Number.isFinite(x));
  if (valid.length < cfg.minHistoryDaysForRank) return null;
  if (!Number.isFinite(currentIV)) return null;
  let below = 0;
  for (const h of valid) if (h < currentIV) below++;
  return (below / valid.length) * 100;
}

/**
 * Unusual-flow heuristic. We require BOTH:
 *   - volume / open interest ≥ unusualVolumeOiRatio (default 2.0), AND
 *   - open interest ≥ unusualMinOpenInterest
 * to avoid false positives on illiquid names where 5 contracts on 2 OI
 * trivially trips a ratio.
 */
export function detectUnusual(
  agg: { callVolume: number; putVolume: number; callOpenInterest: number; putOpenInterest: number },
  cfg: typeof OPTIONS_CONFIG = OPTIONS_CONFIG
): { unusualCalls: boolean; unusualPuts: boolean } {
  const isUnusual = (vol: number, oi: number) =>
    oi >= cfg.unusualMinOpenInterest && vol / oi >= cfg.unusualVolumeOiRatio;
  return {
    unusualCalls: isUnusual(agg.callVolume, agg.callOpenInterest),
    unusualPuts: isUnusual(agg.putVolume, agg.putOpenInterest),
  };
}

/**
 * End-to-end pure aggregation: take a chain slice + historical IV series
 * and produce the OptionsActivity that gets persisted + folded into the
 * Analysis. No I/O, no clock reads.
 */
export function evaluateOptionsActivity(
  slice: OptionsChainSlice | null,
  historicalIV: number[],
  cfg: typeof OPTIONS_CONFIG = OPTIONS_CONFIG
): OptionsActivity {
  if (slice === null) {
    return emptyActivity();
  }
  const atmCall = pickAtm(slice.calls, slice.underlyingPrice, cfg);
  const atmPut = pickAtm(slice.puts, slice.underlyingPrice, cfg);
  // Use the call IV when both are present (less skew bias) — fall back
  // to whichever side exists.
  const atmIV =
    atmCall?.impliedVolatility ?? atmPut?.impliedVolatility ?? null;
  const agg = aggregateSides(slice);
  const pcr = putCallRatio(agg.callVolume, agg.putVolume);
  const skew = calcSkew(atmCall, atmPut);
  const ivRank = atmIV !== null ? calcIVRank(atmIV, historicalIV, cfg) : null;
  const unusual = detectUnusual(agg, cfg);

  const scoreAdjustment = computeOptionsScoreAdjustment(
    { ivRank, unusualCalls: unusual.unusualCalls, unusualPuts: unusual.unusualPuts },
    cfg
  );

  return {
    atmIV,
    ivRank,
    putCallRatio: pcr,
    skew,
    unusualCalls: unusual.unusualCalls,
    unusualPuts: unusual.unusualPuts,
    callVolume: agg.callVolume,
    putVolume: agg.putVolume,
    callOpenInterest: agg.callOpenInterest,
    putOpenInterest: agg.putOpenInterest,
    scoreAdjustment,
  };
}

function emptyActivity(): OptionsActivity {
  return {
    atmIV: null,
    ivRank: null,
    putCallRatio: null,
    skew: null,
    unusualCalls: false,
    unusualPuts: false,
    callVolume: 0,
    putVolume: 0,
    callOpenInterest: 0,
    putOpenInterest: 0,
    scoreAdjustment: 0,
  };
}

/**
 * Sum the IV-rank + unusual-flow boosts into a single score adjustment.
 * Boosts are independent and sum (e.g. high IV + unusual puts = -20).
 */
export function computeOptionsScoreAdjustment(
  inputs: { ivRank: number | null; unusualCalls: boolean; unusualPuts: boolean },
  cfg: typeof OPTIONS_CONFIG = OPTIONS_CONFIG
): number {
  let adj = 0;
  if (inputs.ivRank !== null) {
    if (inputs.ivRank < cfg.ivRankLowPercentile) adj += cfg.ivRankLowBoost;
    else if (inputs.ivRank > cfg.ivRankHighPercentile) adj += cfg.ivRankHighBoost;
  }
  if (inputs.unusualCalls) adj += cfg.unusualCallBoost;
  if (inputs.unusualPuts) adj += cfg.unusualPutBoost;
  return adj;
}

function clampScore(s: number): number {
  if (s > 100) return 100;
  if (s < -100) return -100;
  return s;
}

function scoreToRecommendation(score: number): Analysis["recommendation"] {
  if (score >= RECOMMENDATION_THRESHOLDS.strongBuy) return "STRONG BUY";
  if (score >= RECOMMENDATION_THRESHOLDS.buy) return "BUY";
  if (score > RECOMMENDATION_THRESHOLDS.sell) return "HOLD";
  if (score > RECOMMENDATION_THRESHOLDS.strongSell) return "SELL";
  return "STRONG SELL";
}

/** Synthesise UI signals from an OptionsActivity. Pure helper for the apply step. */
function activityToSignals(
  activity: OptionsActivity,
  cfg: typeof OPTIONS_CONFIG
): TechnicalSignal[] {
  const out: TechnicalSignal[] = [];
  if (activity.ivRank !== null) {
    if (activity.ivRank < cfg.ivRankLowPercentile) {
      out.push({
        label: "Low IV",
        detail: `IV rank ${activity.ivRank.toFixed(0)} — cheap to express via options`,
        type: "buy",
        weight: cfg.ivRankLowBoost,
      });
    } else if (activity.ivRank > cfg.ivRankHighPercentile) {
      out.push({
        label: "High IV",
        detail: `IV rank ${activity.ivRank.toFixed(0)} — move likely priced in (vol crush risk)`,
        type: "sell",
        weight: cfg.ivRankHighBoost,
      });
    }
  }
  if (activity.unusualCalls) {
    out.push({
      label: "Unusual Calls",
      detail: `Call volume ${activity.callVolume.toLocaleString()} vs OI ${activity.callOpenInterest.toLocaleString()}`,
      type: "buy",
      weight: cfg.unusualCallBoost,
    });
  }
  if (activity.unusualPuts) {
    out.push({
      label: "Unusual Puts",
      detail: `Put volume ${activity.putVolume.toLocaleString()} vs OI ${activity.putOpenInterest.toLocaleString()}`,
      type: "sell",
      weight: cfg.unusualPutBoost,
    });
  }
  return out;
}

/**
 * Decorate an Analysis with OptionsActivity + apply the score adjustment.
 * Pure — returns a new Analysis, never mutates input. When
 * `activity.scoreAdjustment === 0` (no usable rank, no unusual flow) we
 * still attach the data so the UI can render IV / P/C ratio info.
 */
export function applyOptionsAdjustment(
  analysis: Analysis,
  activity: OptionsActivity,
  cfg: typeof OPTIONS_CONFIG = OPTIONS_CONFIG
): Analysis {
  if (activity.scoreAdjustment === 0) {
    return { ...analysis, options: activity };
  }
  const newScore = clampScore(analysis.compositeScore + activity.scoreAdjustment);
  return {
    ...analysis,
    compositeScore: newScore,
    recommendation: scoreToRecommendation(newScore),
    options: activity,
    signals: [...analysis.signals, ...activityToSignals(activity, cfg)],
  };
}
