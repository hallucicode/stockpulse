import { describe, it, expect } from "vitest";
import {
  classifyRegime,
  applyRegimeAdjustment,
  adjustSignalWeight,
  calcADX,
  percentileOf,
  REGIME_WEIGHTS,
} from "@/lib/regime";
import type { Analysis, HistoricalBar, TechnicalSignal } from "@/types";

function mkBars(
  closes: number[],
  highs?: number[],
  lows?: number[]
): HistoricalBar[] {
  return closes.map((c, i) => ({
    date: new Date(2026, 0, i + 1).toISOString().slice(0, 10),
    open: c,
    high: highs?.[i] ?? c * 1.01,
    low: lows?.[i] ?? c * 0.99,
    close: c,
    volume: 1_000_000,
  }));
}

function mkSignal(
  type: TechnicalSignal["type"],
  category: TechnicalSignal["category"],
  weight: number
): TechnicalSignal {
  return { label: "T", detail: "x", type, category, weight };
}

function mkAnalysis(signals: TechnicalSignal[]): Analysis {
  const total = signals.reduce((a, s) => a + s.weight, 0);
  return {
    symbol: "X",
    price: 100,
    rsi: 50,
    sma20: 100,
    sma50: 100,
    bollingerUpper: 110,
    bollingerLower: 90,
    bollingerMid: 100,
    macdLine: 0,
    macdSignal: 0,
    macdHistogram: 0,
    dayChange: 0,
    weekChange: 0,
    monthChange: 0,
    avgDailyVolatility: 1,
    compositeScore: total,
    recommendation: "HOLD",
    signals,
  };
}

describe("classifyRegime", () => {
  it("returns high_vol_crisis on extreme VIX level (≥ 30)", () => {
    expect(
      classifyRegime({
        spyClose: 500,
        spy200dma: 480,
        adx14: 30,
        vixLevel: 35,
        vixPercentile: 60,
      })
    ).toBe("high_vol_crisis");
  });

  it("returns high_vol_crisis on extreme VIX percentile (≥ 90)", () => {
    expect(
      classifyRegime({
        spyClose: 500,
        spy200dma: 480,
        adx14: 30,
        vixLevel: 20,
        vixPercentile: 95,
      })
    ).toBe("high_vol_crisis");
  });

  it("returns trending_up when SPY > 200dma and ADX is strong", () => {
    expect(
      classifyRegime({
        spyClose: 510,
        spy200dma: 480,
        adx14: 28,
        vixLevel: 18,
        vixPercentile: 40,
      })
    ).toBe("trending_up");
  });

  it("returns trending_down when SPY < 200dma and ADX is strong", () => {
    expect(
      classifyRegime({
        spyClose: 460,
        spy200dma: 500,
        adx14: 28,
        vixLevel: 22,
        vixPercentile: 70,
      })
    ).toBe("trending_down");
  });

  it("returns ranging when ADX is weak even if SPY drifts", () => {
    expect(
      classifyRegime({
        spyClose: 510,
        spy200dma: 480,
        adx14: 15, // below threshold
        vixLevel: 18,
        vixPercentile: 40,
      })
    ).toBe("ranging");
  });

  it("returns ranging when SPY is essentially flat vs 200dma", () => {
    expect(
      classifyRegime({
        spyClose: 500.5,
        spy200dma: 500,
        adx14: 30,
        vixLevel: 18,
        vixPercentile: 40,
      })
    ).toBe("ranging");
  });

  it("handles spy200dma=0 without dividing by zero", () => {
    expect(
      classifyRegime({
        spyClose: 100,
        spy200dma: 0,
        adx14: 30,
        vixLevel: 18,
        vixPercentile: 40,
      })
    ).toBe("ranging");
  });
});

describe("adjustSignalWeight", () => {
  it("amplifies momentum + dampens mean-reversion in trending_up", () => {
    const mom = mkSignal("buy", "momentum", 10);
    const mr = mkSignal("buy", "mean_reversion", 10);
    expect(adjustSignalWeight(mom, "trending_up")).toBeCloseTo(15);
    expect(adjustSignalWeight(mr, "trending_up")).toBeCloseTo(5);
  });

  it("halves buys + amplifies sells in trending_down", () => {
    const buy = mkSignal("buy", "momentum", 10);
    const sell = mkSignal("sell", "momentum", -10);
    expect(adjustSignalWeight(buy, "trending_down")).toBeCloseTo(5);
    expect(adjustSignalWeight(sell, "trending_down")).toBeCloseTo(-15);
  });

  it("amplifies mean-reversion in ranging", () => {
    const mr = mkSignal("buy", "mean_reversion", 30);
    expect(adjustSignalWeight(mr, "ranging")).toBeCloseTo(45);
  });

  it("dampens everything in high_vol_crisis (buys especially)", () => {
    const buy = mkSignal("buy", "momentum", 30);
    const sell = mkSignal("sell", "momentum", -30);
    expect(adjustSignalWeight(buy, "high_vol_crisis")).toBeCloseTo(30 * 0.3 * 0.3);
    // Sells get full direction multiplier (×1) + category multiplier (×0.3).
    expect(adjustSignalWeight(sell, "high_vol_crisis")).toBeCloseTo(-30 * 0.3);
  });

  it("leaves weight unchanged when category is missing (legacy signal)", () => {
    const s: TechnicalSignal = { label: "L", detail: "d", type: "buy", weight: 10 };
    expect(adjustSignalWeight(s, "trending_up")).toBe(10);
  });
});

describe("applyRegimeAdjustment", () => {
  it("recomputes compositeScore from regime-adjusted weights", () => {
    const a = mkAnalysis([
      mkSignal("buy", "momentum", 10),
      mkSignal("buy", "mean_reversion", 10),
    ]);
    // trending_up: momentum ×1.5 + mean_reversion ×0.5 → 15 + 5 = 20
    const out = applyRegimeAdjustment(a, "trending_up");
    expect(out.compositeScore).toBe(20);
    expect(out.regime?.regime).toBe("trending_up");
  });

  it("updates recommendation when adjusted score crosses a threshold", () => {
    // Score 30 (BUY). In trending_down, sell direction halves buys to 15,
    // crossing back into BUY threshold... but adjusted is 30 * 0.5 = 15 (BUY).
    const a = mkAnalysis([mkSignal("buy", "momentum", 30)]);
    const out = applyRegimeAdjustment(a, "trending_down");
    expect(out.compositeScore).toBe(15);
    expect(out.recommendation).toBe("BUY");
  });

  it("clamps adjusted score to [-100, 100]", () => {
    const a = mkAnalysis(
      Array.from({ length: 5 }, () => mkSignal("buy", "momentum", 30))
    );
    const out = applyRegimeAdjustment(a, "trending_up");
    // 5 × 30 × 1.5 = 225 → clamps to 100
    expect(out.compositeScore).toBe(100);
  });

  it("does not mutate input", () => {
    const a = mkAnalysis([mkSignal("buy", "momentum", 10)]);
    const before = JSON.parse(JSON.stringify(a));
    applyRegimeAdjustment(a, "trending_up");
    expect(a).toEqual(before);
  });
});

describe("calcADX", () => {
  it("returns 0 when history is too short", () => {
    expect(calcADX([])).toBe(0);
    expect(calcADX(mkBars([1, 2, 3]))).toBe(0);
  });

  it("returns a positive value on a clean monotonic uptrend", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i);
    const highs = closes.map((c) => c + 1);
    const lows = closes.map((c) => c - 0.5);
    const adx = calcADX(mkBars(closes, highs, lows));
    expect(adx).toBeGreaterThan(0);
    expect(adx).toBeLessThanOrEqual(100);
  });

  it("returns a relatively low ADX on flat/noisy series", () => {
    const closes = Array.from({ length: 80 }, (_, i) =>
      i % 2 === 0 ? 100 : 100.5
    );
    const trendingCloses = Array.from({ length: 80 }, (_, i) => 100 + i);
    const flat = calcADX(mkBars(closes));
    const trending = calcADX(mkBars(trendingCloses));
    expect(trending).toBeGreaterThan(flat);
  });
});

describe("percentileOf", () => {
  it("returns 0 for value lower than all series", () => {
    expect(percentileOf(5, [10, 20, 30])).toBe(0);
  });
  it("returns ~100 for value higher than all series", () => {
    expect(percentileOf(100, [10, 20, 30])).toBe(100);
  });
  it("returns ~50 for the middle of a uniform series", () => {
    const series = Array.from({ length: 100 }, (_, i) => i);
    expect(percentileOf(50, series)).toBeCloseTo(50, 0);
  });
  it("returns 50 for empty series (safe default)", () => {
    expect(percentileOf(42, [])).toBe(50);
  });
});

describe("REGIME_WEIGHTS table", () => {
  it("has an entry per regime with sensible signs", () => {
    expect(REGIME_WEIGHTS.trending_up.momentumMultiplier).toBeGreaterThan(1);
    expect(
      REGIME_WEIGHTS.trending_up.meanReversionMultiplier
    ).toBeLessThan(1);
    expect(REGIME_WEIGHTS.trending_down.buyMultiplier).toBeLessThan(1);
    expect(REGIME_WEIGHTS.trending_down.sellMultiplier).toBeGreaterThan(1);
    expect(REGIME_WEIGHTS.ranging.meanReversionMultiplier).toBeGreaterThan(1);
    expect(REGIME_WEIGHTS.high_vol_crisis.buyMultiplier).toBeLessThan(1);
  });
});
