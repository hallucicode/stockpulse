// Phase 6 — market regime detection (pure module).
//
// Pure per CLAUDE.md "Pure core, side effects at edges": this file
// contains the classifier (given numeric inputs, what regime are we in?),
// the ADX math, the per-regime weight tables, and the score-adjustment
// function. The orchestrator (background-fetcher) does the I/O — reads
// SPY/VIX history, calls `classifyRegime`, applies `applyRegimeAdjustment`
// to each per-stock analysis.
//
// Why regime weighting matters: mean-reversion (RSI, Bollinger) prints
// money in choppy markets and bleeds in strong trends. Momentum (SMA,
// MACD) does the opposite. The vanilla score weights both equally, which
// is "average" — meaning consistently mediocre. Applying regime-aware
// multipliers tilts the score toward whichever family of signals
// actually works *in the current environment*.

import type {
  Analysis,
  HistoricalBar,
  Regime,
  RegimeInfo,
  TechnicalSignal,
} from "@/types";
import { REGIME_CONFIG, RECOMMENDATION_THRESHOLDS } from "./config";

// ─── Per-regime weight tables ─────────────────────────────────────────
//
// Each regime maps to four multipliers. A signal's final weight =
// raw_weight × category_multiplier × direction_multiplier.
//
// Rationale per cell:
//   trending_up: trends like to keep trending. Momentum signals (SMA
//     cross, MACD) get amplified; mean-reversion (RSI oversold,
//     Bollinger touch) gets dampened — a stock can stay "oversold" for
//     weeks in a uptrend without bouncing.
//   trending_down: cut the size of every BUY signal in half (don't
//     fight the trend), amplify SELL signals (they tend to be right).
//   ranging: classic mean-reversion environment; mean-reversion gets
//     boosted, momentum gets dampened (false breakouts dominate).
//   high_vol_crisis: signals all become unreliable; dampen everything,
//     keep SELL signals at full strength because risk-off matters more
//     than missing a bottom.
export const REGIME_WEIGHTS: Record<Regime, RegimeInfo> = {
  trending_up: {
    regime: "trending_up",
    meanReversionMultiplier: 0.5,
    momentumMultiplier: 1.5,
    buyMultiplier: 1.0,
    sellMultiplier: 1.0,
  },
  trending_down: {
    regime: "trending_down",
    meanReversionMultiplier: 1.0,
    momentumMultiplier: 1.0,
    buyMultiplier: 0.5,
    sellMultiplier: 1.5,
  },
  ranging: {
    regime: "ranging",
    meanReversionMultiplier: 1.5,
    momentumMultiplier: 0.5,
    buyMultiplier: 1.0,
    sellMultiplier: 1.0,
  },
  high_vol_crisis: {
    regime: "high_vol_crisis",
    meanReversionMultiplier: 0.3,
    momentumMultiplier: 0.3,
    buyMultiplier: 0.3,
    sellMultiplier: 1.0,
  },
};

// ─── Classifier ──────────────────────────────────────────────────────

export interface RegimeInputs {
  spyClose: number;
  spy200dma: number;
  adx14: number;
  vixLevel: number;
  vixPercentile: number; // 0–100
}

export function classifyRegime(inputs: RegimeInputs): Regime {
  const cfg = REGIME_CONFIG;

  // Crisis precedes everything: when fear is elevated, signal noise
  // dominates and the right answer is "be small / be cash".
  if (
    inputs.vixLevel >= cfg.vixCrisisLevel ||
    inputs.vixPercentile >= cfg.vixCrisisPercentile
  ) {
    return "high_vol_crisis";
  }

  // Trending requires BOTH direction (price vs MA) AND strength (ADX).
  // ADX alone can be misleading: a stock falling in a straight line has
  // high ADX. Pairing with SPY-vs-MA tells us which kind of trend.
  const ratio = inputs.spy200dma === 0 ? 1 : inputs.spyClose / inputs.spy200dma;
  if (inputs.adx14 >= cfg.adxTrendingThreshold) {
    if (ratio > 1 + cfg.spyTrendDeviationPct) return "trending_up";
    if (ratio < 1 - cfg.spyTrendDeviationPct) return "trending_down";
  }

  return "ranging";
}

// ─── ADX (Average Directional Index, Wilder's smoothing) ──────────────
//
// Returns 0 when history is too short. Otherwise returns ADX as a value
// roughly 0–60+ (in practice anything above ~25 is meaningfully trending).
export function calcADX(history: HistoricalBar[], period = 14): number {
  if (history.length < period * 2 + 1) return 0;

  // Per-bar TR, +DM, -DM.
  const trList: number[] = [];
  const plusDmList: number[] = [];
  const minusDmList: number[] = [];

  for (let i = 1; i < history.length; i++) {
    const cur = history[i];
    const prev = history[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
    trList.push(tr);
    plusDmList.push(plusDm);
    minusDmList.push(minusDm);
  }

  if (trList.length < period * 2) return 0;

  // Wilder's smoothing: initial value is simple sum of first `period`.
  let smTr = trList.slice(0, period).reduce((a, b) => a + b, 0);
  let smPlusDm = plusDmList.slice(0, period).reduce((a, b) => a + b, 0);
  let smMinusDm = minusDmList.slice(0, period).reduce((a, b) => a + b, 0);

  const dxList: number[] = [];
  for (let i = period; i < trList.length; i++) {
    smTr = smTr - smTr / period + trList[i];
    smPlusDm = smPlusDm - smPlusDm / period + plusDmList[i];
    smMinusDm = smMinusDm - smMinusDm / period + minusDmList[i];

    if (smTr === 0) continue;
    const plusDi = (100 * smPlusDm) / smTr;
    const minusDi = (100 * smMinusDm) / smTr;
    const diSum = plusDi + minusDi;
    if (diSum === 0) continue;
    const dx = (100 * Math.abs(plusDi - minusDi)) / diSum;
    dxList.push(dx);
  }

  if (dxList.length === 0) return 0;
  // ADX = average of DX over the last `period` values (Wilder's smoothed).
  const window = dxList.slice(-period);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

// ─── VIX percentile ──────────────────────────────────────────────────

export function percentileOf(value: number, series: number[]): number {
  if (series.length === 0) return 50;
  const below = series.filter((v) => v < value).length;
  return Math.max(0, Math.min(100, (below / series.length) * 100));
}

// ─── Score adjustment ────────────────────────────────────────────────

export function adjustSignalWeight(
  signal: TechnicalSignal,
  regime: Regime
): number {
  const w = REGIME_WEIGHTS[regime];
  let m = 1;
  if (signal.category === "mean_reversion") m *= w.meanReversionMultiplier;
  else if (signal.category === "momentum") m *= w.momentumMultiplier;
  if (signal.type === "buy") m *= w.buyMultiplier;
  else if (signal.type === "sell") m *= w.sellMultiplier;
  return signal.weight * m;
}

function clampScore(score: number): number {
  if (score > 100) return 100;
  if (score < -100) return -100;
  return score;
}

function scoreToRecommendation(score: number): Analysis["recommendation"] {
  if (score >= RECOMMENDATION_THRESHOLDS.strongBuy) return "STRONG BUY";
  if (score >= RECOMMENDATION_THRESHOLDS.buy) return "BUY";
  if (score > RECOMMENDATION_THRESHOLDS.sell) return "HOLD";
  if (score > RECOMMENDATION_THRESHOLDS.strongSell) return "SELL";
  return "STRONG SELL";
}

/**
 * Recompute compositeScore using regime-adjusted per-signal weights,
 * then recompute recommendation from the adjusted score. Pure: returns
 * a new Analysis; never mutates input. Attaches `regime` metadata so
 * the UI can show which multipliers were applied.
 */
export function applyRegimeAdjustment(
  analysis: Analysis,
  regime: Regime
): Analysis {
  const info = REGIME_WEIGHTS[regime];
  let newScore = 0;
  for (const sig of analysis.signals) {
    newScore += adjustSignalWeight(sig, regime);
  }
  newScore = clampScore(Math.round(newScore));
  return {
    ...analysis,
    compositeScore: newScore,
    recommendation: scoreToRecommendation(newScore),
    regime: info,
  };
}
