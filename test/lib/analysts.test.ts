import { describe, it, expect } from "vitest";
import {
  evaluateAnalystActivity,
  applyAnalystAdjustment,
  type AnalystEvent,
} from "@/lib/analysts";
import type { Analysis } from "@/types";

const NOW = new Date("2026-04-27T12:00:00Z");

function ev(
  daysAgo: number,
  action: string,
  firm = "GS",
  toGrade: string | null = "Buy"
): AnalystEvent {
  return {
    firm,
    fromGrade: "Hold",
    toGrade,
    action,
    publishedAt: new Date(NOW.getTime() - daysAgo * 86_400_000),
  };
}

function mkAnalysis(score = 20): Analysis {
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

describe("evaluateAnalystActivity", () => {
  it("counts upgrades and downgrades within the boost window (14d)", () => {
    const r = evaluateAnalystActivity(
      [ev(2, "up"), ev(4, "down"), ev(6, "up")],
      NOW
    );
    expect(r.recentUpgrades).toBe(2);
    expect(r.recentDowngrades).toBe(1);
  });

  it("ignores actions outside the 14-day window", () => {
    const r = evaluateAnalystActivity(
      [ev(20, "up"), ev(30, "down"), ev(2, "up")],
      NOW
    );
    expect(r.recentUpgrades).toBe(1);
    expect(r.recentDowngrades).toBe(0);
  });

  it("scoreAdjustment = +10 for any upgrade with no downgrade", () => {
    const r = evaluateAnalystActivity([ev(2, "up")], NOW);
    expect(r.scoreAdjustment).toBe(10);
  });

  it("scoreAdjustment = -10 for any downgrade with no upgrade", () => {
    const r = evaluateAnalystActivity([ev(2, "down")], NOW);
    expect(r.scoreAdjustment).toBe(-10);
  });

  it("scoreAdjustment = 0 when both upgrade and downgrade exist (mixed)", () => {
    const r = evaluateAnalystActivity([ev(2, "up"), ev(3, "down")], NOW);
    expect(r.scoreAdjustment).toBe(0);
  });

  it("scoreAdjustment = 0 for 'init' / 'main' actions", () => {
    expect(
      evaluateAnalystActivity([ev(2, "init")], NOW).scoreAdjustment
    ).toBe(0);
    expect(
      evaluateAnalystActivity([ev(2, "main")], NOW).scoreAdjustment
    ).toBe(0);
  });

  it("returns the most recent action as `latest`", () => {
    const r = evaluateAnalystActivity(
      [ev(5, "up", "Citi"), ev(2, "up", "GS"), ev(8, "down", "BoA")],
      NOW
    );
    expect(r.latest?.firm).toBe("GS");
  });

  it("returns latest=null when no actions in window", () => {
    const r = evaluateAnalystActivity([], NOW);
    expect(r.latest).toBeNull();
  });
});

describe("applyAnalystAdjustment", () => {
  it("attaches activity unchanged when scoreAdjustment is 0", () => {
    const a = mkAnalysis(20);
    const out = applyAnalystAdjustment(a, {
      recentUpgrades: 0,
      recentDowngrades: 0,
      latest: null,
      scoreAdjustment: 0,
    });
    expect(out.compositeScore).toBe(20);
    expect(out.analysts).toBeDefined();
  });

  it("nudges score and recomputes recommendation on upgrade", () => {
    const a = mkAnalysis(30);
    const out = applyAnalystAdjustment(a, {
      recentUpgrades: 1,
      recentDowngrades: 0,
      latest: {
        firm: "GS",
        action: "up",
        fromGrade: "Hold",
        toGrade: "Buy",
        date: NOW.toISOString(),
      },
      scoreAdjustment: 10,
    });
    expect(out.compositeScore).toBe(40);
    expect(out.recommendation).toBe("STRONG BUY");
  });

  it("nudges score down on downgrade", () => {
    const a = mkAnalysis(20);
    const out = applyAnalystAdjustment(a, {
      recentUpgrades: 0,
      recentDowngrades: 1,
      latest: {
        firm: "BoA",
        action: "down",
        fromGrade: "Buy",
        toGrade: "Hold",
        date: NOW.toISOString(),
      },
      scoreAdjustment: -10,
    });
    expect(out.compositeScore).toBe(10);
    expect(out.recommendation).toBe("HOLD");
  });

  it("clamps score at -100", () => {
    const a = mkAnalysis(-95);
    const out = applyAnalystAdjustment(a, {
      recentUpgrades: 0,
      recentDowngrades: 1,
      latest: null,
      scoreAdjustment: -10,
    });
    expect(out.compositeScore).toBe(-100);
  });

  it("does not mutate the input analysis", () => {
    const a = mkAnalysis(20);
    const before = JSON.parse(JSON.stringify(a));
    applyAnalystAdjustment(a, {
      recentUpgrades: 1,
      recentDowngrades: 0,
      latest: null,
      scoreAdjustment: 10,
    });
    expect(a).toEqual(before);
  });
});
