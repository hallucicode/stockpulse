import { describe, it, expect } from "vitest";
import { computePositionSize } from "@/lib/position-sizing";
import { RISK_CONFIG } from "@/lib/config";

describe("computePositionSize", () => {
  describe("happy paths", () => {
    it("sizes a clean uncapped trade correctly", () => {
      // Portfolio $100k, risk 1% = $1000 budget. Entry $50, stop $30 →
      // $20/share risk → 50 shares = $2500 = 2.5% of portfolio. Well under
      // the 10% cap, so risk math wins.
      const result = computePositionSize({
        portfolioValueUsd: 100_000,
        entry: 50,
        stop: 30,
        riskPct: 0.01,
      });
      expect(result).not.toBeNull();
      expect(result!.shares).toBe(50);
      expect(result!.dollarValue).toBe(2500);
      expect(result!.portfolioPct).toBeCloseTo(0.025, 6);
      expect(result!.cappedByPositionLimit).toBe(false);
    });

    it("tight-stop high-price name gets capped by maxPositionPct (NVDA-style)", () => {
      // Phase 14 mock-up uses NVDA entry $432 stop $409 (tight $23 stop).
      // At $50k portfolio 1% risk = $500 budget → raw 21 shares = $9,072 =
      // 18% of portfolio. The 10% cap kicks in → 11 shares = $4,752 = ~9.5%.
      const result = computePositionSize({
        portfolioValueUsd: 50_000,
        entry: 432,
        stop: 409,
        riskPct: 0.01,
      });
      expect(result).not.toBeNull();
      expect(result!.shares).toBe(11);
      expect(result!.cappedByPositionLimit).toBe(true);
      // Honoured the cap: position ≤ 10% of portfolio.
      expect(result!.portfolioPct).toBeLessThanOrEqual(0.1);
    });

    it("uses RISK_CONFIG.riskPerTradePct when riskPct is omitted", () => {
      const result = computePositionSize({
        portfolioValueUsd: 100_000,
        entry: 100,
        stop: 90,
      });
      // Defaults: 1% = $1000 risk, $10 per-share risk → 100 shares.
      // Position cap: 10% of $100k / $100 = 100 shares — equal, not capped.
      expect(result).not.toBeNull();
      expect(result!.shares).toBe(100);
      expect(result!.dollarValue).toBe(10_000);
      // 10_000 / 100_000 = 0.10 exactly.
      expect(result!.portfolioPct).toBeCloseTo(0.1, 10);
      // Raw shares == cap → "rawShares > cap" is false → not flagged.
      expect(result!.cappedByPositionLimit).toBe(false);
    });

    it("respects the maxPositionPct cap when the trade would otherwise overweight", () => {
      // Very tight stop → naive sizing would buy a huge slug. Cap should bite.
      const result = computePositionSize({
        portfolioValueUsd: 100_000,
        entry: 100,
        stop: 99,
        riskPct: 0.01, // $1000 risk
        // $1000 / $1 = 1000 raw shares = $100k = 100% of portfolio.
        // Cap at 10% = $10k = 100 shares.
      });
      expect(result).not.toBeNull();
      expect(result!.shares).toBe(100);
      expect(result!.dollarValue).toBe(10_000);
      expect(result!.portfolioPct).toBeCloseTo(0.1, 10);
      expect(result!.cappedByPositionLimit).toBe(true);
    });

    it("accepts a custom riskPct + maxPositionPct override", () => {
      const result = computePositionSize({
        portfolioValueUsd: 10_000,
        entry: 50,
        stop: 45,
        riskPct: 0.02, // 2% = $200
        maxPositionPct: 0.25, // 25% = $2500
      });
      // $200 / $5 = 40 shares = $2000 = 20% — under the 25% cap.
      expect(result).not.toBeNull();
      expect(result!.shares).toBe(40);
      expect(result!.cappedByPositionLimit).toBe(false);
    });
  });

  describe("null returns (degenerate input)", () => {
    it("returns null when portfolio value is zero", () => {
      expect(
        computePositionSize({ portfolioValueUsd: 0, entry: 100, stop: 90 })
      ).toBeNull();
    });

    it("returns null when portfolio value is negative", () => {
      expect(
        computePositionSize({ portfolioValueUsd: -100, entry: 100, stop: 90 })
      ).toBeNull();
    });

    it("returns null when entry equals stop (no risk distance)", () => {
      expect(
        computePositionSize({
          portfolioValueUsd: 10_000,
          entry: 100,
          stop: 100,
        })
      ).toBeNull();
    });

    it("returns null when stop is above entry (would be a short, not a long)", () => {
      expect(
        computePositionSize({
          portfolioValueUsd: 10_000,
          entry: 100,
          stop: 110,
        })
      ).toBeNull();
    });

    it("returns null when entry is zero", () => {
      expect(
        computePositionSize({ portfolioValueUsd: 10_000, entry: 0, stop: -5 })
      ).toBeNull();
    });

    it("returns null when stop is zero or negative", () => {
      expect(
        computePositionSize({ portfolioValueUsd: 10_000, entry: 50, stop: 0 })
      ).toBeNull();
      expect(
        computePositionSize({ portfolioValueUsd: 10_000, entry: 50, stop: -5 })
      ).toBeNull();
    });

    it("returns null when riskPct is zero or negative", () => {
      expect(
        computePositionSize({
          portfolioValueUsd: 10_000,
          entry: 50,
          stop: 45,
          riskPct: 0,
        })
      ).toBeNull();
      expect(
        computePositionSize({
          portfolioValueUsd: 10_000,
          entry: 50,
          stop: 45,
          riskPct: -0.01,
        })
      ).toBeNull();
    });

    it("returns null when maxPositionPct is zero or negative", () => {
      expect(
        computePositionSize({
          portfolioValueUsd: 10_000,
          entry: 50,
          stop: 45,
          maxPositionPct: 0,
        })
      ).toBeNull();
    });

    it("returns null on NaN portfolio value", () => {
      expect(
        computePositionSize({ portfolioValueUsd: NaN, entry: 100, stop: 90 })
      ).toBeNull();
    });

    it("returns null on Infinity inputs", () => {
      expect(
        computePositionSize({
          portfolioValueUsd: Infinity,
          entry: 100,
          stop: 90,
        })
      ).toBeNull();
      expect(
        computePositionSize({
          portfolioValueUsd: 10_000,
          entry: Infinity,
          stop: 90,
        })
      ).toBeNull();
      expect(
        computePositionSize({
          portfolioValueUsd: 10_000,
          entry: 100,
          stop: NaN,
        })
      ).toBeNull();
      expect(
        computePositionSize({
          portfolioValueUsd: 10_000,
          entry: 100,
          stop: 90,
          riskPct: NaN,
        })
      ).toBeNull();
      expect(
        computePositionSize({
          portfolioValueUsd: 10_000,
          entry: 100,
          stop: 90,
          maxPositionPct: NaN,
        })
      ).toBeNull();
    });

    it("returns null when the share count rounds down to zero (entry > risk budget)", () => {
      // $1000 portfolio, 1% = $10 risk budget. Per-share risk $50.
      // Raw shares = 0.2 → floor 0 → null.
      expect(
        computePositionSize({
          portfolioValueUsd: 1000,
          entry: 200,
          stop: 150,
          riskPct: 0.01,
        })
      ).toBeNull();
    });
  });

  describe("sanity checks", () => {
    it("uses defaultPortfolioValue happily (the first-trade case)", () => {
      // No portfolio yet — caller passes RISK_CONFIG.defaultPortfolioValue.
      // $10k × 1% = $100 risk budget; entry $50 stop $45 → $5/share → 20 shares.
      // Position cap: 10% × $10k = $1000 / $50 = 20 — equal, not capped.
      const result = computePositionSize({
        portfolioValueUsd: RISK_CONFIG.defaultPortfolioValue,
        entry: 50,
        stop: 45,
      });
      expect(result!.shares).toBe(20);
      expect(result!.cappedByPositionLimit).toBe(false);
    });

    it("returns whole shares always (never fractional)", () => {
      const result = computePositionSize({
        portfolioValueUsd: 12_345,
        entry: 78.91,
        stop: 70.5,
      });
      expect(result).not.toBeNull();
      expect(Number.isInteger(result!.shares)).toBe(true);
    });
  });
});
