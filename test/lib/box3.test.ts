import { describe, it, expect } from "vitest";
import {
  computePortfolioValueEur,
  convertUsdToEur,
  estimateBox3Liability,
} from "@/lib/box3";
import { BOX3_CONFIG } from "@/lib/config";

describe("convertUsdToEur", () => {
  it("multiplies by the rate and rounds to cents", () => {
    expect(convertUsdToEur(100, 0.92)).toBe(92);
    expect(convertUsdToEur(150.789, 0.9215)).toBeCloseTo(138.95, 2);
  });

  it("handles 0 amount and 0 rate", () => {
    expect(convertUsdToEur(0, 0.92)).toBe(0);
    expect(convertUsdToEur(100, 0)).toBe(0);
  });

  it("returns NaN for non-finite inputs", () => {
    expect(convertUsdToEur(Number.NaN, 0.92)).toBeNaN();
    expect(convertUsdToEur(100, Number.NaN)).toBeNaN();
    expect(convertUsdToEur(100, Number.POSITIVE_INFINITY)).toBeNaN();
    expect(convertUsdToEur(Number.NEGATIVE_INFINITY, 0.92)).toBeNaN();
  });

  it("is symmetric on signed inputs (negative position values pass through)", () => {
    expect(convertUsdToEur(-100, 0.92)).toBe(-92);
  });
});

describe("computePortfolioValueEur", () => {
  it("returns zeros for an empty portfolio", () => {
    const r = computePortfolioValueEur([], 0.92);
    expect(r).toEqual({
      usdEurRate: 0.92,
      totalValueUsd: 0,
      totalValueEur: 0,
      positions: [],
      fallbackCount: 0,
    });
  });

  it("aggregates a multi-position portfolio in input order", () => {
    const r = computePortfolioValueEur(
      [
        { symbol: "AAPL", shares: 10, currentPriceUsd: 180, buyPriceUsd: 150 },
        { symbol: "MSFT", shares: 5, currentPriceUsd: 400, buyPriceUsd: 380 },
      ],
      0.92
    );
    expect(r.totalValueUsd).toBe(1800 + 2000);
    expect(r.totalValueEur).toBe(convertUsdToEur(3800, 0.92));
    expect(r.positions.map((p) => p.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(r.positions[0].valueUsd).toBe(1800);
    expect(r.positions[0].usedFallbackPrice).toBe(false);
    expect(r.fallbackCount).toBe(0);
  });

  it("falls back to buyPrice when currentPriceUsd is null and flags the position", () => {
    const r = computePortfolioValueEur(
      [
        { symbol: "STALE", shares: 10, currentPriceUsd: null, buyPriceUsd: 50 },
        { symbol: "FRESH", shares: 5, currentPriceUsd: 200, buyPriceUsd: 100 },
      ],
      0.92
    );
    expect(r.positions[0].effectivePriceUsd).toBe(50);
    expect(r.positions[0].usedFallbackPrice).toBe(true);
    expect(r.positions[1].usedFallbackPrice).toBe(false);
    expect(r.fallbackCount).toBe(1);
    // Total still uses the fallback (so the operator at least sees a
    // ballpark, not "missing" zero).
    expect(r.totalValueUsd).toBe(50 * 10 + 200 * 5);
  });

  it("preserves the input FX rate on the output", () => {
    const r = computePortfolioValueEur([], 0.8765);
    expect(r.usdEurRate).toBe(0.8765);
  });
});

describe("estimateBox3Liability", () => {
  it("returns zero estimated tax when totalValueEur is at the threshold", () => {
    const r = estimateBox3Liability(BOX3_CONFIG.heffingsvrijVermogen);
    expect(r.taxableBaseEur).toBe(0);
    expect(r.deemedReturnEur).toBe(0);
    expect(r.estimatedTaxEur).toBe(0);
  });

  it("returns zero estimated tax when totalValueEur is below the threshold", () => {
    const r = estimateBox3Liability(BOX3_CONFIG.heffingsvrijVermogen - 1);
    expect(r.taxableBaseEur).toBe(0);
    expect(r.estimatedTaxEur).toBe(0);
  });

  it("computes deemed return × tax rate on the over-threshold amount", () => {
    // Pick a clean value above the 2024 threshold (57000) for hand math.
    const over = 100_000;
    const totalValueEur = BOX3_CONFIG.heffingsvrijVermogen + over;
    const r = estimateBox3Liability(totalValueEur);
    expect(r.taxableBaseEur).toBe(over);
    expect(r.deemedReturnEur).toBeCloseTo(
      over * BOX3_CONFIG.deemedReturnRateOverigeBezittingen,
      6
    );
    expect(r.estimatedTaxEur).toBeCloseTo(
      over *
        BOX3_CONFIG.deemedReturnRateOverigeBezittingen *
        BOX3_CONFIG.box3TaxRate,
      6
    );
  });

  it("surfaces every config-derived field for transparency in the UI", () => {
    const r = estimateBox3Liability(200_000);
    expect(r.heffingsvrijVermogen).toBe(BOX3_CONFIG.heffingsvrijVermogen);
    expect(r.deemedReturnRate).toBe(
      BOX3_CONFIG.deemedReturnRateOverigeBezittingen
    );
    expect(r.taxRate).toBe(BOX3_CONFIG.box3TaxRate);
    expect(r.taxYear).toBe(BOX3_CONFIG.taxYear);
  });

  it("respects a custom config override (e.g. a hypothetical 2027 calc)", () => {
    const cfg = {
      ...BOX3_CONFIG,
      taxYear: 2027,
      heffingsvrijVermogen: 60_000,
      deemedReturnRateOverigeBezittingen: 0.07,
      box3TaxRate: 0.4,
    };
    const r = estimateBox3Liability(160_000, cfg);
    // Taxable base = 160000 - 60000 = 100000
    // Deemed return = 100000 * 0.07 = 7000
    // Tax = 7000 * 0.4 = 2800
    expect(r.taxableBaseEur).toBe(100_000);
    expect(r.deemedReturnEur).toBeCloseTo(7000, 6);
    expect(r.estimatedTaxEur).toBeCloseTo(2800, 6);
    expect(r.taxYear).toBe(2027);
  });
});
