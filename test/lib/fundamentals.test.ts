import { describe, it, expect } from "vitest";
import {
  evaluateFundamentals,
  applyFundamentalsAdjustment,
} from "@/lib/fundamentals";
import type { Analysis, Fundamentals } from "@/types";

function f(overrides: Partial<Fundamentals> = {}): Fundamentals {
  return {
    marketCap: 500_000_000, // $500M — passes microcap floor
    peRatio: 20,
    debtToEquity: 1,
    freeCashFlowTtm: 50_000_000,
    epsTtm: 2.5,
    revenueGrowthYoy: 8,
    hasReportedEarnings: true,
    ...overrides,
  };
}

function makeAnalysis(score = 30, overrides: Partial<Analysis> = {}): Analysis {
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
    compositeScore: score,
    recommendation: "BUY",
    signals: [],
    ...overrides,
  };
}

describe("evaluateFundamentals", () => {
  it("returns null for a clean, viable company", () => {
    expect(evaluateFundamentals(f())).toBeNull();
  });

  it("vetoes when market cap and EPS are both null (unknown_fundamentals)", () => {
    const v = evaluateFundamentals(
      f({ marketCap: null, epsTtm: null, hasReportedEarnings: false })
    );
    expect(v?.reason).toBe("unknown_fundamentals");
  });

  it("vetoes when hasReportedEarnings is false (no_earnings)", () => {
    const v = evaluateFundamentals(
      f({ epsTtm: null, hasReportedEarnings: false, marketCap: 500_000_000 })
    );
    expect(v?.reason).toBe("no_earnings");
  });

  it("vetoes when epsTtm is null even if hasReportedEarnings is true (defensive)", () => {
    // Inconsistent input — better to veto than to crash later.
    const v = evaluateFundamentals(
      f({ epsTtm: null, hasReportedEarnings: true, marketCap: 500_000_000 })
    );
    expect(v?.reason).toBe("no_earnings");
  });

  it("vetoes microcap (market cap < $50M)", () => {
    const v = evaluateFundamentals(f({ marketCap: 10_000_000 }));
    expect(v?.reason).toBe("microcap");
    expect(v?.detail).toContain("$10.0M");
  });

  it("does NOT veto on the boundary ($50M exactly)", () => {
    const v = evaluateFundamentals(f({ marketCap: 50_000_000 }));
    expect(v?.reason).not.toBe("microcap");
  });

  it("vetoes cash-burning company (negative EPS + negative growth)", () => {
    const v = evaluateFundamentals(f({ epsTtm: -1.5, revenueGrowthYoy: -10 }));
    expect(v?.reason).toBe("cash_burning");
    expect(v?.detail).toContain("-1.50");
    expect(v?.detail).toContain("-10");
  });

  it("does NOT flag negative EPS with positive revenue growth (growth-stage loss-maker)", () => {
    expect(
      evaluateFundamentals(f({ epsTtm: -2, revenueGrowthYoy: 25 }))
    ).toBeNull();
  });

  it("vetoes over-leveraged (debt/equity > 5)", () => {
    const v = evaluateFundamentals(f({ debtToEquity: 8 }));
    expect(v?.reason).toBe("over_leveraged");
  });

  it("does NOT flag negative growth alone if profitable", () => {
    // Mature, profitable companies sometimes shrink revenue (e.g. divestiture).
    // Without losses too, that's not a kill signal.
    expect(
      evaluateFundamentals(f({ epsTtm: 3, revenueGrowthYoy: -5 }))
    ).toBeNull();
  });

  it("priority: no_earnings beats microcap when both fire", () => {
    const v = evaluateFundamentals(
      f({
        marketCap: 5_000_000,
        epsTtm: null,
        hasReportedEarnings: false,
      })
    );
    expect(v?.reason).toBe("no_earnings");
  });

  it("priority: microcap beats cash_burning when both fire", () => {
    const v = evaluateFundamentals(
      f({
        marketCap: 5_000_000,
        epsTtm: -1,
        revenueGrowthYoy: -20,
      })
    );
    expect(v?.reason).toBe("microcap");
  });
});

describe("applyFundamentalsAdjustment", () => {
  it("returns the analysis unchanged when fundamentals=null (cold start)", () => {
    const a = makeAnalysis(20);
    const out = applyFundamentalsAdjustment(a, null);
    expect(out).toBe(a);
  });

  it("preserves an existing Phase 2.5 veto (does not overwrite)", () => {
    const a = makeAnalysis(20, {
      qualityVeto: { reason: "penny_stock", detail: "..." },
    });
    const out = applyFundamentalsAdjustment(
      a,
      f({ marketCap: 1_000_000, epsTtm: -3, hasReportedEarnings: false })
    );
    expect(out.qualityVeto?.reason).toBe("penny_stock");
  });

  it("attaches a fundamentals veto when the analysis has none", () => {
    const a = makeAnalysis(20);
    const out = applyFundamentalsAdjustment(
      a,
      f({ epsTtm: null, hasReportedEarnings: false, marketCap: 500_000_000 })
    );
    expect(out.qualityVeto?.reason).toBe("no_earnings");
  });

  it("does not mutate the input analysis", () => {
    const a = makeAnalysis(20);
    const before = JSON.parse(JSON.stringify(a));
    applyFundamentalsAdjustment(
      a,
      f({ epsTtm: null, hasReportedEarnings: false, marketCap: 500_000_000 })
    );
    expect(a).toEqual(before);
  });

  it("returns the analysis unchanged when fundamentals pass all gates", () => {
    const a = makeAnalysis(20);
    const out = applyFundamentalsAdjustment(a, f());
    expect(out.qualityVeto).toBeUndefined();
  });
});
