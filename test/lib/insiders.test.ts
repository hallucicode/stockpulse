import { describe, it, expect } from "vitest";
import {
  evaluateInsiderActivity,
  applyInsiderAdjustment,
  type InsiderTxn,
} from "@/lib/insiders";
import type { Analysis } from "@/types";

const NOW = new Date("2026-04-27T12:00:00Z");

function txn(
  filerName: string,
  daysAgo: number,
  shareChange: number,
  transactionCode: string | null = "P",
  totalValue: number | null = 100000
): InsiderTxn {
  return {
    filerName,
    transactionDate: new Date(NOW.getTime() - daysAgo * 86_400_000),
    transactionCode,
    shareChange,
    totalValue,
  };
}

function mkAnalysis(score = 30): Analysis {
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
  };
}

describe("evaluateInsiderActivity", () => {
  it("flags cluster buy when ≥2 distinct insiders bought within 14 days", () => {
    const r = evaluateInsiderActivity(
      [txn("Alice", 3, 1000), txn("Bob", 5, 500)],
      NOW
    );
    expect(r.hasClusterBuy).toBe(true);
    expect(r.clusterBuyerCount).toBe(2);
    expect(r.scoreAdjustment).toBeGreaterThan(0);
  });

  it("does NOT flag cluster on single insider buying multiple times", () => {
    // Same person × 3 buys = no cluster.
    const r = evaluateInsiderActivity(
      [
        txn("Alice", 1, 1000),
        txn("Alice", 5, 500),
        txn("Alice", 10, 2000),
      ],
      NOW
    );
    expect(r.hasClusterBuy).toBe(false);
    expect(r.clusterBuyerCount).toBe(1);
    expect(r.scoreAdjustment).toBe(0);
  });

  it("ignores buys outside the 14-day cluster window", () => {
    const r = evaluateInsiderActivity(
      [
        txn("Alice", 30, 1000), // outside cluster window (14d)
        txn("Bob", 5, 500), // within
      ],
      NOW
    );
    expect(r.hasClusterBuy).toBe(false);
  });

  it("ignores sells (negative shareChange)", () => {
    const r = evaluateInsiderActivity(
      [txn("Alice", 3, -1000), txn("Bob", 5, -500)],
      NOW
    );
    expect(r.hasClusterBuy).toBe(false);
    expect(r.scoreAdjustment).toBe(0);
  });

  it("ignores non-P transaction codes (e.g. M = option exercise)", () => {
    const r = evaluateInsiderActivity(
      [txn("Alice", 3, 1000, "M"), txn("Bob", 5, 500, "A")],
      NOW
    );
    // M and A are option-exercise / award — not bullish signals.
    expect(r.hasClusterBuy).toBe(false);
  });

  it("treats missing transactionCode as buy when shareChange > 0", () => {
    // Finnhub sometimes omits the code; sign of change is the fallback.
    const r = evaluateInsiderActivity(
      [txn("Alice", 3, 1000, null), txn("Bob", 5, 500, null)],
      NOW
    );
    expect(r.hasClusterBuy).toBe(true);
  });

  it("sums totalValue across the score-boost window (30 days)", () => {
    const r = evaluateInsiderActivity(
      [
        txn("Alice", 3, 1000, "P", 200_000),
        txn("Bob", 10, 500, "P", 50_000),
        txn("Charlie", 60, 2000, "P", 1_000_000), // outside 30d boost window
      ],
      NOW
    );
    expect(r.recentBuyValueUsd).toBe(250_000);
  });

  it("returns lastBuyAt as the most recent buy", () => {
    const r = evaluateInsiderActivity(
      [txn("Alice", 1, 1000), txn("Bob", 5, 500)],
      NOW
    );
    expect(new Date(r.lastBuyAt!).getTime()).toBe(
      NOW.getTime() - 1 * 86_400_000
    );
  });

  it("returns lastBuyAt=null when no buys exist", () => {
    const r = evaluateInsiderActivity([txn("Alice", 1, -1000)], NOW);
    expect(r.lastBuyAt).toBeNull();
  });
});

describe("applyInsiderAdjustment", () => {
  it("attaches activity but doesn't change score when no cluster", () => {
    const a = mkAnalysis(20);
    const out = applyInsiderAdjustment(a, {
      hasClusterBuy: false,
      clusterBuyerCount: 1,
      recentBuyValueUsd: 0,
      lastBuyAt: null,
      scoreAdjustment: 0,
    });
    expect(out.compositeScore).toBe(20);
    expect(out.insiders).toBeDefined();
  });

  it("boosts score and recomputes recommendation on cluster", () => {
    const a = mkAnalysis(30); // BUY
    const out = applyInsiderAdjustment(a, {
      hasClusterBuy: true,
      clusterBuyerCount: 3,
      recentBuyValueUsd: 500_000,
      lastBuyAt: NOW.toISOString(),
      scoreAdjustment: 15,
    });
    expect(out.compositeScore).toBe(45);
    expect(out.recommendation).toBe("STRONG BUY");
    expect(out.insiders?.hasClusterBuy).toBe(true);
  });

  it("clamps score at +100", () => {
    const a = mkAnalysis(95);
    const out = applyInsiderAdjustment(a, {
      hasClusterBuy: true,
      clusterBuyerCount: 4,
      recentBuyValueUsd: 1_000_000,
      lastBuyAt: NOW.toISOString(),
      scoreAdjustment: 15,
    });
    expect(out.compositeScore).toBe(100);
  });

  it("does not mutate the input analysis", () => {
    const a = mkAnalysis(20);
    const before = JSON.parse(JSON.stringify(a));
    applyInsiderAdjustment(a, {
      hasClusterBuy: true,
      clusterBuyerCount: 2,
      recentBuyValueUsd: 100_000,
      lastBuyAt: NOW.toISOString(),
      scoreAdjustment: 15,
    });
    expect(a).toEqual(before);
  });
});
