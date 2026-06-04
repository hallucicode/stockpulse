import { describe, it, expect } from "vitest";
import { buildWhyCheap } from "@/lib/trade-rationale";
import type { Analysis } from "@/types";

// Tiny factory — only the fields the rationale builder reads. Everything else
// is satisfied with no-ops to keep tests focused on the branch being tested.
function makeAnalysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    symbol: "TST",
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
    compositeScore: 0,
    recommendation: "HOLD",
    signals: [],
    ...overrides,
  };
}

describe("buildWhyCheap", () => {
  it("returns the sector-selloff rationale when diagnosis says so", () => {
    const result = buildWhyCheap(
      makeAnalysis({
        diagnosis: {
          category: "sector_selloff",
          rationale: "",
          newsCount: 3,
          scoreAdjustment: 0,
        },
      })
    );
    expect(result).toMatch(/sector-wide selloff/i);
  });

  it("returns the earnings-miss rationale", () => {
    const result = buildWhyCheap(
      makeAnalysis({
        diagnosis: {
          category: "earnings_miss",
          rationale: "",
          newsCount: 1,
          scoreAdjustment: -5,
        },
      })
    );
    expect(result).toMatch(/earnings miss/i);
  });

  it("returns the analyst-downgrade rationale", () => {
    const result = buildWhyCheap(
      makeAnalysis({
        diagnosis: {
          category: "analyst_downgrade",
          rationale: "",
          newsCount: 1,
          scoreAdjustment: -3,
        },
      })
    );
    expect(result).toMatch(/downgrade priced in/i);
  });

  it("uses sector rotation when there's no diagnosis hit", () => {
    const result = buildWhyCheap(
      makeAnalysis({
        sectorRotation: {
          state: "turning_up",
          etfSymbol: "XLK",
          close: 200,
          sma200: 195,
          recentRunBars: 5,
        },
      })
    );
    expect(result).toMatch(/XLK/);
    expect(result).toMatch(/rotating/i);
  });

  it("falls back to relative-strength text in a trending_down regime", () => {
    const result = buildWhyCheap(
      makeAnalysis({
        regime: {
          regime: "trending_down",
          meanReversionMultiplier: 1,
          momentumMultiplier: 1,
          buyMultiplier: 1,
          sellMultiplier: 1,
        },
      })
    );
    expect(result).toMatch(/relative strength/i);
  });

  it("uses technical-pullback for technical_only diagnosis + negative dayChange", () => {
    const result = buildWhyCheap(
      makeAnalysis({
        dayChange: -2.5,
        diagnosis: {
          category: "technical_only",
          rationale: "",
          newsCount: 0,
          scoreAdjustment: 0,
        },
      })
    );
    expect(result).toMatch(/technical pullback/i);
  });

  it("does NOT use technical-pullback when dayChange is non-negative", () => {
    // Up day with no news doesn't justify a "cheap" rationale.
    const result = buildWhyCheap(
      makeAnalysis({
        dayChange: 1.2,
        diagnosis: {
          category: "technical_only",
          rationale: "",
          newsCount: 0,
          scoreAdjustment: 0,
        },
      })
    );
    expect(result).toBeNull();
  });

  it("uses 'multiple catalysts' when confidence >= 2 and no higher rationale fires", () => {
    const result = buildWhyCheap(
      makeAnalysis({
        catalysts: {
          score: 10,
          present: ["earnings_upcoming", "insider_cluster"],
          confidence: 2,
        },
      })
    );
    expect(result).toMatch(/multiple catalysts/i);
  });

  it("returns null when catalyst confidence is 1 (not enough)", () => {
    const result = buildWhyCheap(
      makeAnalysis({
        catalysts: {
          score: 5,
          present: ["earnings_upcoming"],
          confidence: 1,
        },
      })
    );
    expect(result).toBeNull();
  });

  it("returns null when nothing diagnostic is present", () => {
    expect(buildWhyCheap(makeAnalysis())).toBeNull();
  });

  it("does NOT invent a rationale on fraud / guidance_cut / lawsuit", () => {
    // Red-flag categories explicitly do not get a 'why cheap' line — the
    // diagnosis chip itself is the warning.
    for (const category of ["fraud", "guidance_cut", "lawsuit"] as const) {
      const result = buildWhyCheap(
        makeAnalysis({
          diagnosis: {
            category,
            rationale: "",
            newsCount: 1,
            scoreAdjustment: -10,
          },
        })
      );
      expect(result).toBeNull();
    }
  });

  it("respects ordering: diagnosis beats sector rotation beats regime", () => {
    // All three fire. sector_selloff should win.
    const result = buildWhyCheap(
      makeAnalysis({
        diagnosis: {
          category: "sector_selloff",
          rationale: "",
          newsCount: 1,
          scoreAdjustment: 0,
        },
        sectorRotation: {
          state: "turning_up",
          etfSymbol: "XLK",
          close: 200,
          sma200: 195,
          recentRunBars: 5,
        },
        regime: {
          regime: "trending_down",
          meanReversionMultiplier: 1,
          momentumMultiplier: 1,
          buyMultiplier: 1,
          sellMultiplier: 1,
        },
      })
    );
    expect(result).toMatch(/sector-wide selloff/i);
  });
});
