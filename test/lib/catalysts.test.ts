import { describe, it, expect } from "vitest";
import {
  evaluateCatalysts,
  applyCatalystAdjustment,
} from "@/lib/catalysts";
import { CATALYST_CONFIG } from "@/lib/config";
import type { Analysis } from "@/types";

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
    compositeScore: 30,
    recommendation: "BUY",
    signals: [],
    ...overrides,
  };
}

describe("evaluateCatalysts", () => {
  it("returns an empty/zero result when no catalysts are present", () => {
    const info = evaluateCatalysts({});
    expect(info).toEqual({ score: 0, present: [], confidence: 0 });
  });

  it("flags upcoming earnings within the catalyst window", () => {
    const info = evaluateCatalysts({ earnings: { daysUntil: 14 } });
    expect(info.present).toEqual(["earnings_upcoming"]);
    expect(info.score).toBe(CATALYST_CONFIG.weights.earnings_upcoming);
    expect(info.confidence).toBe(1);
  });

  it("ignores earnings beyond the catalyst window", () => {
    const info = evaluateCatalysts({
      earnings: { daysUntil: CATALYST_CONFIG.earningsCatalystWindowDays + 1 },
    });
    expect(info.present).not.toContain("earnings_upcoming");
  });

  it("ignores past earnings (negative daysUntil)", () => {
    const info = evaluateCatalysts({ earnings: { daysUntil: -1 } });
    expect(info.present).not.toContain("earnings_upcoming");
  });

  it("counts a same-day earnings event (daysUntil = 0)", () => {
    const info = evaluateCatalysts({ earnings: { daysUntil: 0 } });
    expect(info.present).toContain("earnings_upcoming");
  });

  it("flags cluster insider buys", () => {
    const info = evaluateCatalysts({ insiders: { hasClusterBuy: true } });
    expect(info.present).toEqual(["insider_cluster"]);
    expect(info.score).toBe(CATALYST_CONFIG.weights.insider_cluster);
  });

  it("ignores insider activity without a cluster", () => {
    const info = evaluateCatalysts({ insiders: { hasClusterBuy: false } });
    expect(info.present).not.toContain("insider_cluster");
  });

  it("flags recent analyst upgrades", () => {
    const info = evaluateCatalysts({ analysts: { recentUpgrades: 1 } });
    expect(info.present).toEqual(["analyst_upgrade"]);
    expect(info.score).toBe(CATALYST_CONFIG.weights.analyst_upgrade);
  });

  it("does not flag upgrade when recentUpgrades is 0", () => {
    const info = evaluateCatalysts({ analysts: { recentUpgrades: 0 } });
    expect(info.present).not.toContain("analyst_upgrade");
  });

  it("flags each positive-news diagnosis category", () => {
    for (const category of CATALYST_CONFIG.positiveNewsCategories) {
      const info = evaluateCatalysts({ diagnosis: { category } });
      expect(info.present).toContain("positive_news");
    }
  });

  it("does NOT flag positive_news for negative or neutral categories", () => {
    for (const category of [
      "fraud",
      "guidance_cut",
      "earnings_miss",
      "merger",
      "leadership_change",
      "technical_only",
      "unknown",
    ] as const) {
      const info = evaluateCatalysts({ diagnosis: { category } });
      expect(info.present).not.toContain("positive_news");
    }
  });

  it("flags sector_rotation only on the bullish `turning_up` state (Phase 7.1)", () => {
    const turningUp = evaluateCatalysts({
      sectorRotation: { state: "turning_up" },
    });
    expect(turningUp.present).toContain("sector_rotation");
    expect(turningUp.score).toBe(CATALYST_CONFIG.weights.sector_rotation);

    // None of the other states fire the catalyst — only the *transition*
    // up from a long downtrend is a catalyst event.
    for (const state of [
      "trending_up",
      "flat",
      "trending_down",
      "turning_down",
    ] as const) {
      const info = evaluateCatalysts({ sectorRotation: { state } });
      expect(info.present).not.toContain("sector_rotation");
    }
  });

  it("aggregates multiple catalysts (sum of weights, distinct presence list)", () => {
    const info = evaluateCatalysts({
      earnings: { daysUntil: 10 },
      insiders: { hasClusterBuy: true },
      analysts: { recentUpgrades: 2 },
      diagnosis: { category: "product_launch" },
    });
    expect(new Set(info.present)).toEqual(
      new Set([
        "earnings_upcoming",
        "insider_cluster",
        "analyst_upgrade",
        "positive_news",
      ])
    );
    expect(info.confidence).toBe(4);
    expect(info.score).toBe(
      CATALYST_CONFIG.weights.earnings_upcoming +
        CATALYST_CONFIG.weights.insider_cluster +
        CATALYST_CONFIG.weights.analyst_upgrade +
        CATALYST_CONFIG.weights.positive_news
    );
  });

  it("is pure — same input twice yields equal output", () => {
    const input = {
      earnings: { daysUntil: 5 },
      insiders: { hasClusterBuy: true },
    };
    expect(evaluateCatalysts(input)).toEqual(evaluateCatalysts(input));
  });

  it("respects an injected config override", () => {
    const cfg = {
      ...CATALYST_CONFIG,
      weights: { ...CATALYST_CONFIG.weights, insider_cluster: 99 },
    };
    const info = evaluateCatalysts(
      { insiders: { hasClusterBuy: true } },
      cfg
    );
    expect(info.score).toBe(99);
  });
});

describe("applyCatalystAdjustment", () => {
  it("attaches a zero CatalystInfo when nothing is decorated yet", () => {
    const out = applyCatalystAdjustment(baseAnalysis());
    expect(out.catalysts).toEqual({
      score: 0,
      present: [],
      confidence: 0,
    });
  });

  it("does NOT modify compositeScore (avoid double-counting Phase 3/4/5 nudges)", () => {
    const input = baseAnalysis({
      compositeScore: 42,
      insiders: {
        hasClusterBuy: true,
        clusterBuyerCount: 3,
        recentBuyValueUsd: 1_000_000,
        lastBuyAt: new Date().toISOString(),
        scoreAdjustment: 15,
      },
    });
    const out = applyCatalystAdjustment(input);
    expect(out.compositeScore).toBe(42);
    expect(out.recommendation).toBe(input.recommendation);
  });

  it("does not mutate its input (returns a new object)", () => {
    const input = baseAnalysis();
    const out = applyCatalystAdjustment(input);
    expect(out).not.toBe(input);
    expect(input.catalysts).toBeUndefined();
  });

  it("aggregates real Analysis-shaped catalyst fields end-to-end", () => {
    const input = baseAnalysis({
      earnings: { nextDate: "2026-06-01", daysUntil: 12, imminent: false },
      insiders: {
        hasClusterBuy: true,
        clusterBuyerCount: 2,
        recentBuyValueUsd: 500_000,
        lastBuyAt: new Date().toISOString(),
        scoreAdjustment: 15,
      },
      analysts: {
        recentUpgrades: 1,
        recentDowngrades: 0,
        latest: null,
        scoreAdjustment: 10,
      },
      diagnosis: {
        category: "product_launch",
        rationale: "launched flagship product",
        newsCount: 3,
        scoreAdjustment: 5,
      },
      sectorRotation: {
        state: "turning_up",
        etfSymbol: "XLK",
        close: 200,
        sma200: 190,
        recentRunBars: 3,
      },
    });
    const out = applyCatalystAdjustment(input);
    expect(out.catalysts?.confidence).toBe(5);
    expect(out.catalysts?.present.length).toBe(5);
    expect(out.catalysts?.present).toContain("sector_rotation");
  });
});
