import { describe, it, expect } from "vitest";
import {
  aggregateSides,
  applyOptionsAdjustment,
  calcIVRank,
  calcSkew,
  computeOptionsScoreAdjustment,
  detectUnusual,
  evaluateOptionsActivity,
  pickAtm,
  putCallRatio,
  type OptionContract,
  type OptionsChainSlice,
} from "@/lib/options";
import { OPTIONS_CONFIG } from "@/lib/config";
import type { Analysis } from "@/types";

function contract(
  strike: number,
  iv: number,
  volume = 0,
  openInterest = 0
): OptionContract {
  return { strike, impliedVolatility: iv, volume, openInterest };
}

function baseAnalysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    symbol: "TEST",
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
    compositeScore: 20,
    recommendation: "BUY",
    signals: [],
    ...overrides,
  };
}

describe("pickAtm", () => {
  it("returns null on an empty chain", () => {
    expect(pickAtm([], 100)).toBeNull();
  });

  it("picks the strike closest to the underlying price", () => {
    const c = pickAtm(
      [contract(95, 0.3), contract(100, 0.32), contract(105, 0.31)],
      101
    );
    expect(c?.strike).toBe(100);
  });

  it("returns null when no strike sits within tolerance", () => {
    // Underlying 100, tolerance default 5%, only strikes at 50 and 200.
    const c = pickAtm([contract(50, 0.3), contract(200, 0.3)], 100);
    expect(c).toBeNull();
  });

  it("respects an override tolerance", () => {
    const c = pickAtm([contract(120, 0.3)], 100, {
      ...OPTIONS_CONFIG,
      atmTolerancePct: 0.25,
    });
    expect(c?.strike).toBe(120);
  });
});

describe("aggregateSides", () => {
  it("sums volume and open interest across each side", () => {
    const slice: OptionsChainSlice = {
      underlyingPrice: 100,
      calls: [contract(100, 0.3, 50, 200), contract(105, 0.32, 25, 100)],
      puts: [contract(95, 0.34, 80, 150), contract(100, 0.36, 20, 50)],
    };
    expect(aggregateSides(slice)).toEqual({
      callVolume: 75,
      putVolume: 100,
      callOpenInterest: 300,
      putOpenInterest: 200,
    });
  });

  it("treats missing volume/OI fields as zero", () => {
    const slice: OptionsChainSlice = {
      underlyingPrice: 100,
      calls: [{ strike: 100, impliedVolatility: 0.3 }],
      puts: [{ strike: 100, impliedVolatility: 0.3 }],
    };
    expect(aggregateSides(slice)).toEqual({
      callVolume: 0,
      putVolume: 0,
      callOpenInterest: 0,
      putOpenInterest: 0,
    });
  });
});

describe("putCallRatio", () => {
  it("returns put/call when call volume is positive", () => {
    expect(putCallRatio(100, 50)).toBe(0.5);
  });

  it("returns null (not infinity) when call volume is zero", () => {
    expect(putCallRatio(0, 50)).toBeNull();
    expect(putCallRatio(0, 0)).toBeNull();
  });
});

describe("calcSkew", () => {
  it("returns put IV minus call IV when both ATM strikes exist", () => {
    expect(calcSkew(contract(100, 0.30), contract(100, 0.34))).toBeCloseTo(0.04, 5);
  });

  it("returns null when either side is missing", () => {
    expect(calcSkew(null, contract(100, 0.3))).toBeNull();
    expect(calcSkew(contract(100, 0.3), null)).toBeNull();
  });
});

describe("calcIVRank", () => {
  const enough = Array(OPTIONS_CONFIG.minHistoryDaysForRank).fill(0.3);

  it("returns null when there's not enough history", () => {
    expect(calcIVRank(0.3, [0.2, 0.4])).toBeNull();
  });

  it("returns the percentile of current IV within the historical series", () => {
    const history = [
      ...Array(50).fill(0.2),
      ...Array(50).fill(0.4),
    ];
    // current=0.3 → 50% of history is below it.
    expect(calcIVRank(0.3, history)).toBe(50);
  });

  it("returns 0 when current IV is the lowest", () => {
    expect(calcIVRank(0.1, enough)).toBe(0);
  });

  it("returns near-100 when current IV is the highest", () => {
    expect(calcIVRank(0.99, enough)).toBe(100);
  });

  it("returns null when current IV is non-finite", () => {
    expect(calcIVRank(Number.NaN, enough)).toBeNull();
  });

  it("ignores non-finite history values when counting the denominator", () => {
    const history = [
      ...Array(OPTIONS_CONFIG.minHistoryDaysForRank).fill(0.2),
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];
    // 60 valid values, all 0.2; current 0.3 → 100% above
    expect(calcIVRank(0.3, history)).toBe(100);
  });
});

describe("detectUnusual", () => {
  it("flags side when volume ≥ 2× open interest AND OI ≥ floor", () => {
    const r = detectUnusual({
      callVolume: 300,
      callOpenInterest: 100,
      putVolume: 10,
      putOpenInterest: 5,
    });
    expect(r.unusualCalls).toBe(true);
    // Puts have OI=5 (< unusualMinOpenInterest=100), so even ratio 2 doesn't fire.
    expect(r.unusualPuts).toBe(false);
  });

  it("does NOT flag side when volume is just below 2× OI", () => {
    const r = detectUnusual({
      callVolume: 199,
      callOpenInterest: 100,
      putVolume: 0,
      putOpenInterest: 0,
    });
    expect(r.unusualCalls).toBe(false);
  });

  it("does NOT flag a side with zero open interest", () => {
    const r = detectUnusual({
      callVolume: 1000,
      callOpenInterest: 0,
      putVolume: 0,
      putOpenInterest: 0,
    });
    expect(r.unusualCalls).toBe(false);
  });
});

describe("computeOptionsScoreAdjustment", () => {
  it("returns zero when no signal fires", () => {
    expect(
      computeOptionsScoreAdjustment({
        ivRank: null,
        unusualCalls: false,
        unusualPuts: false,
      })
    ).toBe(0);
  });

  it("adds low-IV boost when rank is below threshold", () => {
    expect(
      computeOptionsScoreAdjustment({ ivRank: 10, unusualCalls: false, unusualPuts: false })
    ).toBe(OPTIONS_CONFIG.ivRankLowBoost);
  });

  it("subtracts high-IV penalty when rank is above threshold", () => {
    expect(
      computeOptionsScoreAdjustment({ ivRank: 90, unusualCalls: false, unusualPuts: false })
    ).toBe(OPTIONS_CONFIG.ivRankHighBoost);
  });

  it("does NOT nudge when rank sits between thresholds", () => {
    expect(
      computeOptionsScoreAdjustment({ ivRank: 50, unusualCalls: false, unusualPuts: false })
    ).toBe(0);
  });

  it("sums independent boosts (high IV + unusual puts = double penalty)", () => {
    expect(
      computeOptionsScoreAdjustment({ ivRank: 95, unusualCalls: false, unusualPuts: true })
    ).toBe(OPTIONS_CONFIG.ivRankHighBoost + OPTIONS_CONFIG.unusualPutBoost);
  });

  it("low-IV + unusual calls sums to a sizeable bullish push", () => {
    expect(
      computeOptionsScoreAdjustment({ ivRank: 5, unusualCalls: true, unusualPuts: false })
    ).toBe(OPTIONS_CONFIG.ivRankLowBoost + OPTIONS_CONFIG.unusualCallBoost);
  });
});

describe("evaluateOptionsActivity", () => {
  const history = Array(OPTIONS_CONFIG.minHistoryDaysForRank).fill(0.35);

  it("returns an empty activity when the slice is null", () => {
    const a = evaluateOptionsActivity(null, history);
    expect(a).toEqual({
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
    });
  });

  it("computes a full happy-path activity end-to-end", () => {
    const slice: OptionsChainSlice = {
      underlyingPrice: 100,
      calls: [
        contract(95, 0.28, 100, 500),
        contract(100, 0.30, 1500, 500), // ATM call — IV 30%, big volume
        contract(105, 0.32, 50, 400),
      ],
      puts: [
        contract(95, 0.36, 200, 300),
        contract(100, 0.34, 150, 400), // ATM put — IV 34%
        contract(105, 0.40, 80, 200),
      ],
    };
    const a = evaluateOptionsActivity(slice, history);
    expect(a.atmIV).toBeCloseTo(0.30, 5);
    expect(a.skew).toBeCloseTo(0.04, 5);
    expect(a.putCallRatio).toBeCloseTo(430 / 1650, 5);
    expect(a.callVolume).toBe(1650);
    expect(a.putVolume).toBe(430);
    // IV 0.30 < history 0.35 → rank 0 (everything in history is above).
    expect(a.ivRank).toBe(0);
    // 1650 / 1400 = 1.18× — below 2.0 ratio, no unusual flag.
    expect(a.unusualCalls).toBe(false);
    // Low-rank fires the bullish boost.
    expect(a.scoreAdjustment).toBe(OPTIONS_CONFIG.ivRankLowBoost);
  });

  it("falls back to put IV when the call side has no ATM contract", () => {
    const slice: OptionsChainSlice = {
      underlyingPrice: 100,
      calls: [], // no calls
      puts: [contract(100, 0.4)],
    };
    const a = evaluateOptionsActivity(slice, history);
    expect(a.atmIV).toBeCloseTo(0.4, 5);
  });
});

describe("applyOptionsAdjustment", () => {
  it("attaches the activity without changing score when scoreAdjustment is 0", () => {
    const input = baseAnalysis({ compositeScore: 42 });
    const out = applyOptionsAdjustment(input, {
      atmIV: 0.35,
      ivRank: 50,
      putCallRatio: 0.8,
      skew: 0.02,
      unusualCalls: false,
      unusualPuts: false,
      callVolume: 0,
      putVolume: 0,
      callOpenInterest: 0,
      putOpenInterest: 0,
      scoreAdjustment: 0,
    });
    expect(out.compositeScore).toBe(42);
    expect(out.options?.atmIV).toBeCloseTo(0.35, 5);
  });

  it("nudges score + recommendation when score adjustment is positive", () => {
    const input = baseAnalysis({ compositeScore: 10, recommendation: "HOLD" });
    const out = applyOptionsAdjustment(input, {
      atmIV: 0.2,
      ivRank: 10,
      putCallRatio: 1,
      skew: 0,
      unusualCalls: true,
      unusualPuts: false,
      callVolume: 1000,
      putVolume: 500,
      callOpenInterest: 100,
      putOpenInterest: 200,
      scoreAdjustment: OPTIONS_CONFIG.ivRankLowBoost + OPTIONS_CONFIG.unusualCallBoost,
    });
    expect(out.compositeScore).toBe(
      10 + OPTIONS_CONFIG.ivRankLowBoost + OPTIONS_CONFIG.unusualCallBoost
    );
    expect(out.recommendation).toBe("BUY");
    // Two signals synthesised: "Low IV" + "Unusual Calls".
    const labels = out.signals.map((s) => s.label);
    expect(labels).toContain("Low IV");
    expect(labels).toContain("Unusual Calls");
  });

  it("clamps the score at -100 / +100", () => {
    const input = baseAnalysis({ compositeScore: 95, recommendation: "STRONG BUY" });
    const out = applyOptionsAdjustment(input, {
      atmIV: 0.2,
      ivRank: 10,
      putCallRatio: 1,
      skew: 0,
      unusualCalls: true,
      unusualPuts: false,
      callVolume: 1000,
      putVolume: 500,
      callOpenInterest: 100,
      putOpenInterest: 200,
      scoreAdjustment: 15,
    });
    expect(out.compositeScore).toBe(100);
  });

  it("synthesises the High IV / Unusual Puts signals on the bear side", () => {
    const input = baseAnalysis({ compositeScore: 20 });
    const out = applyOptionsAdjustment(input, {
      atmIV: 0.6,
      ivRank: 92,
      putCallRatio: 1.8,
      skew: 0.06,
      unusualCalls: false,
      unusualPuts: true,
      callVolume: 200,
      putVolume: 1000,
      callOpenInterest: 500,
      putOpenInterest: 200,
      scoreAdjustment: OPTIONS_CONFIG.ivRankHighBoost + OPTIONS_CONFIG.unusualPutBoost,
    });
    const labels = out.signals.map((s) => s.label);
    expect(labels).toContain("High IV");
    expect(labels).toContain("Unusual Puts");
  });
});
