// Pure module — indicator math + scoring.
//
// PRINCIPLE (see CLAUDE.md "Pure core, side effects at edges"):
// Every function here is a pure function of its inputs. No DB, no clock,
// no network, no logging. This keeps scoring trivially testable, reusable,
// and safe to call from backtests (Phase 11) where determinism matters.
//
// All thresholds and weights come from `./config`. Do not inline numbers.

import type {
  HistoricalBar,
  Analysis,
  TechnicalSignal,
  QualityVeto,
} from "@/types";
import {
  INDICATOR_CONFIG,
  SCORING_WEIGHTS,
  RECOMMENDATION_THRESHOLDS,
  SELL_SIGNAL_CONFIG,
  QUALITY_GATE_CONFIG,
} from "./config";
import { deriveRiskLevels } from "./risk";

// ─── Phase 2.5 quality gate ───
//
// Pure decision: "is this a real, tradeable stock?". Vetoed names are
// excluded from the scanner output (the API filters them — analyses are
// still cached for audit).
//
// Rules live in a flat array so adding a new red flag is one line, not a
// new conditional. Order matters only for which `reason` the user sees
// (first match wins) — every rule has the same outcome (veto).
//
// What's NOT here: real fundamentals (earnings, market cap, debt). Those
// land in Phase 4.5 — they need an external API call so they sit behind
// an edge module, not in this pure file.
export interface QualityGateInput {
  price: number;
  bollingerLower: number;
  recentBars: HistoricalBar[];
}

interface VetoRule {
  id: string;
  predicate: (input: QualityGateInput) => boolean;
  detail: (input: QualityGateInput) => string;
}

function avgDollarVolume(bars: HistoricalBar[]): number {
  if (bars.length === 0) return 0;
  const total = bars.reduce((sum, b) => sum + b.close * b.volume, 0);
  return total / bars.length;
}

function dormantRatio(bars: HistoricalBar[]): number {
  if (bars.length === 0) return 0;
  const zeroes = bars.filter((b) => b.volume === 0).length;
  return zeroes / bars.length;
}

const VETO_RULES: ReadonlyArray<VetoRule> = [
  {
    id: "penny_stock",
    predicate: (i) => i.price < QUALITY_GATE_CONFIG.minPriceUsd,
    detail: (i) =>
      `Price $${i.price.toFixed(2)} is below the $${QUALITY_GATE_CONFIG.minPriceUsd} floor`,
  },
  {
    id: "degenerate_bollinger",
    predicate: (i) => i.bollingerLower <= 0,
    detail: (i) =>
      `Bollinger lower band is $${i.bollingerLower.toFixed(2)} (≤ 0) — volatility too extreme for the signal to mean anything`,
  },
  {
    id: "illiquid",
    predicate: (i) =>
      avgDollarVolume(i.recentBars) <
      QUALITY_GATE_CONFIG.minAvgDailyDollarVolume,
    detail: (i) =>
      `Avg daily dollar volume $${(avgDollarVolume(i.recentBars) / 1000).toFixed(0)}k is below the $${(QUALITY_GATE_CONFIG.minAvgDailyDollarVolume / 1000).toFixed(0)}k floor`,
  },
  {
    id: "dormant",
    predicate: (i) =>
      dormantRatio(i.recentBars) > QUALITY_GATE_CONFIG.maxDormantBarRatio,
    detail: (i) =>
      `${(dormantRatio(i.recentBars) * 100).toFixed(0)}% of recent bars have zero volume — listed but not actively traded`,
  },
];

export function checkQualityGate(input: QualityGateInput): QualityVeto | null {
  for (const rule of VETO_RULES) {
    if (rule.predicate(input)) {
      return { reason: rule.id, detail: rule.detail(input) };
    }
  }
  return null;
}

// ─── Indicators ───

function calcRSI(closes: number[], period = INDICATOR_CONFIG.rsi.period): number {
  if (closes.length < period + 1) return 50;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d;
    else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = gains / period / (losses / period);
  return 100 - 100 / (1 + rs);
}

function calcSMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1];
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcEMA(data: number[], period: number): number {
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcBollinger(
  closes: number[],
  period = INDICATOR_CONFIG.bollinger.period
) {
  if (closes.length < period) {
    const last = closes[closes.length - 1];
    return { upper: last * 1.1, mid: last, lower: last * 0.9 };
  }
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, v) => a + (v - mid) ** 2, 0) / period);
  const k = INDICATOR_CONFIG.bollinger.stdDevMultiplier;
  return { upper: mid + k * std, mid, lower: mid - k * std };
}

function calcMACD(closes: number[]) {
  const { fastPeriod, slowPeriod, signalApproximation } = INDICATOR_CONFIG.macd;
  if (closes.length < slowPeriod) return { line: 0, signal: 0, histogram: 0 };
  const emaFast = calcEMA(closes, fastPeriod);
  const emaSlow = calcEMA(closes, slowPeriod);
  const line = emaFast - emaSlow;

  // NOTE: signal line approximated as `line × 0.8` instead of a true 9-period
  // EMA of the MACD series. Phase 11 will replace this with a proper
  // implementation; the constant lives in INDICATOR_CONFIG.macd so the
  // approximation is at least named, greppable, and replaceable.
  const signal = line * signalApproximation;
  return { line, signal, histogram: line - signal };
}

function calcAvgVolatility(closes: number[]): number {
  let total = 0;
  for (let i = 1; i < closes.length; i++) {
    total += Math.abs((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return (total / (closes.length - 1)) * 100;
}

// ─── Composite Analysis ───

export function analyzeStock(symbol: string, history: HistoricalBar[]): Analysis {
  const closes = history.map((h) => h.close);
  const current = closes[closes.length - 1] ?? 0;
  const prev = closes[closes.length - 2] ?? current;

  const rsi = calcRSI(closes);
  const sma20 = calcSMA(closes, INDICATOR_CONFIG.sma.short);
  const sma50 = calcSMA(closes, INDICATOR_CONFIG.sma.long);
  const boll = calcBollinger(closes);
  const macd = calcMACD(closes);

  const dayChange = prev ? ((current - prev) / prev) * 100 : 0;

  const wkWindow = INDICATOR_CONFIG.weeklyChangeWindow;
  const weekChange =
    closes.length > wkWindow
      ? ((current - closes[closes.length - 1 - wkWindow]) /
          closes[closes.length - 1 - wkWindow]) *
        100
      : 0;

  const moWindow = INDICATOR_CONFIG.monthlyChangeWindow;
  const monthChange =
    closes.length > moWindow
      ? ((current - closes[closes.length - 1 - moWindow]) /
          closes[closes.length - 1 - moWindow]) *
        100
      : 0;

  const avgDailyVolatility = calcAvgVolatility(closes);

  // ─── Signal scoring ───
  let score = 0;
  const signals: TechnicalSignal[] = [];
  const W = SCORING_WEIGHTS;
  const T = INDICATOR_CONFIG.rsi;

  // RSI
  if (rsi < T.deeplyOversold) {
    score += W.rsiOversold;
    signals.push({
      label: "RSI Oversold",
      detail: `RSI at ${rsi.toFixed(0)} — deeply oversold`,
      type: "buy",
      weight: W.rsiOversold,
      category: "mean_reversion",
    });
  } else if (rsi < T.approachingOversold) {
    score += W.rsiLow;
    signals.push({
      label: "RSI Low",
      detail: `RSI at ${rsi.toFixed(0)} — approaching oversold`,
      type: "buy",
      weight: W.rsiLow,
      category: "mean_reversion",
    });
  } else if (rsi > T.deeplyOverbought) {
    score += W.rsiOverbought;
    signals.push({
      label: "RSI Overbought",
      detail: `RSI at ${rsi.toFixed(0)} — deeply overbought`,
      type: "sell",
      weight: W.rsiOverbought,
      category: "mean_reversion",
    });
  } else if (rsi > T.approachingOverbought) {
    score += W.rsiHigh;
    signals.push({
      label: "RSI High",
      detail: `RSI at ${rsi.toFixed(0)} — approaching overbought`,
      type: "sell",
      weight: W.rsiHigh,
      category: "mean_reversion",
    });
  } else {
    signals.push({
      label: "RSI Neutral",
      detail: `RSI at ${rsi.toFixed(0)}`,
      type: "neutral",
      weight: 0,
      category: "mean_reversion",
    });
  }

  // Bollinger Bands
  if (current <= boll.lower) {
    score += W.bollingerLower;
    signals.push({
      label: "Below Lower Bollinger",
      detail: "Price at lower band — potential bounce",
      type: "buy",
      weight: W.bollingerLower,
      category: "mean_reversion",
    });
  } else if (current >= boll.upper) {
    score += W.bollingerUpper;
    signals.push({
      label: "Above Upper Bollinger",
      detail: "Price at upper band — potential pullback",
      type: "sell",
      weight: W.bollingerUpper,
      category: "mean_reversion",
    });
  }

  // SMA crossover
  if (sma20 > sma50 && current > sma20) {
    score += W.smaCrossBullish;
    signals.push({
      label: "Bullish SMA Cross",
      detail: "SMA20 above SMA50, price above both",
      type: "buy",
      weight: W.smaCrossBullish,
      category: "momentum",
    });
  } else if (sma20 < sma50 && current < sma20) {
    score += W.smaCrossBearish;
    signals.push({
      label: "Bearish SMA Cross",
      detail: "SMA20 below SMA50, price below both",
      type: "sell",
      weight: W.smaCrossBearish,
      category: "momentum",
    });
  }

  // MACD
  if (macd.histogram > 0) {
    score += W.macdBullish;
    signals.push({
      label: "MACD Bullish",
      detail: "Positive MACD histogram — upward momentum",
      type: "buy",
      weight: W.macdBullish,
      category: "momentum",
    });
  } else {
    score += W.macdBearish;
    signals.push({
      label: "MACD Bearish",
      detail: "Negative MACD histogram — downward momentum",
      type: "sell",
      weight: W.macdBearish,
      category: "momentum",
    });
  }

  // Mean reversion (key for volatile stocks)
  if (weekChange < W.weeklyDipThreshold) {
    score += W.weeklyDip;
    signals.push({
      label: "Sharp Weekly Dip",
      detail: `Down ${Math.abs(weekChange).toFixed(1)}% this week — mean reversion likely`,
      type: "buy",
      weight: W.weeklyDip,
      category: "mean_reversion",
    });
  } else if (weekChange > W.weeklyRallyThreshold) {
    score += W.weeklyRally;
    signals.push({
      label: "Sharp Weekly Rally",
      detail: `Up ${weekChange.toFixed(1)}% this week — pullback likely`,
      type: "sell",
      weight: W.weeklyRally,
      category: "mean_reversion",
    });
  }

  // Volume spike detection — preserves prior behavior exactly:
  // averages the previous (window − 1) bars and compares to the latest bar.
  const volWindow = INDICATOR_CONFIG.volumeSpikeWindow;
  if (history.length > 10) {
    const denom = volWindow - 1;
    const avgVol =
      history.slice(-volWindow, -1).reduce((a, b) => a + b.volume, 0) / denom;
    const lastVol = history[history.length - 1].volume;
    if (
      lastVol > avgVol * INDICATOR_CONFIG.volumeSpikeMultiple &&
      dayChange < INDICATOR_CONFIG.capitulationDayDrop
    ) {
      score += W.capitulationVolume;
      signals.push({
        label: "Capitulation Volume",
        detail: "Volume spike on sell-off — potential reversal",
        type: "buy",
        weight: W.capitulationVolume,
        category: "mean_reversion",
      });
    }
  }

  // Clamp score
  score = Math.max(W.scoreMin, Math.min(W.scoreMax, score));

  let recommendation: Analysis["recommendation"];
  if (score >= RECOMMENDATION_THRESHOLDS.strongBuy) recommendation = "STRONG BUY";
  else if (score >= RECOMMENDATION_THRESHOLDS.buy) recommendation = "BUY";
  else if (score > RECOMMENDATION_THRESHOLDS.sell) recommendation = "HOLD";
  else if (score > RECOMMENDATION_THRESHOLDS.strongSell) recommendation = "SELL";
  else recommendation = "STRONG SELL";

  // ─── Phase 1 risk packet ───
  // Always populated. Pure function of `history`, so deterministic for tests
  // and backtests. UI guards `risk?` for cached entries written before Phase 1.
  const risk = deriveRiskLevels(history);

  // ─── Phase 2.5 quality gate ───
  // Veto on penny / degenerate / illiquid / dormant names. Vetoed analyses
  // are still cached for audit; the scanner API filters them out by default.
  const qualityVeto = checkQualityGate({
    price: current,
    bollingerLower: boll.lower,
    recentBars: history.slice(-QUALITY_GATE_CONFIG.recentBarsForLiquidity),
  });

  return {
    symbol,
    price: current,
    rsi,
    sma20,
    sma50,
    bollingerUpper: boll.upper,
    bollingerLower: boll.lower,
    bollingerMid: boll.mid,
    macdLine: macd.line,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    dayChange,
    weekChange,
    monthChange,
    avgDailyVolatility,
    compositeScore: score,
    recommendation,
    signals,
    risk,
    qualityVeto: qualityVeto ?? undefined,
  };
}

// ─── Sell signal logic for portfolio ───

export function getSellSignal(
  analysis: Analysis,
  buyPrice: number
): { reason: string; urgency: "low" | "medium" | "high" } | null {
  const plPct = ((analysis.price - buyPrice) / buyPrice) * 100;
  const C = SELL_SIGNAL_CONFIG;

  // Hard stop loss
  if (plPct < C.hardStopLossPct) {
    return {
      reason: `Stop loss: down ${Math.abs(plPct).toFixed(1)}%`,
      urgency: "high",
    };
  }

  // Take profit
  if (plPct > C.takeProfitPct) {
    return { reason: `Take profit: up ${plPct.toFixed(1)}%`, urgency: "medium" };
  }

  // Technical sell signals
  if (analysis.compositeScore <= C.strongBearishScore) {
    return { reason: "Strong bearish signals detected", urgency: "high" };
  }

  if (
    analysis.compositeScore <= C.bearishScoreLockGains &&
    plPct > C.lockGainsMinProfitPct
  ) {
    return {
      reason: "Bearish signals — consider locking in gains",
      urgency: "low",
    };
  }

  if (analysis.rsi > C.rsiOverboughtSellThreshold && plPct > 0) {
    return {
      reason: `RSI overbought at ${analysis.rsi.toFixed(0)} — sell into strength`,
      urgency: "medium",
    };
  }

  return null;
}
