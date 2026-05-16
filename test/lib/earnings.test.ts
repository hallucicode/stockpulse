import { describe, it, expect } from "vitest";
import {
  daysUntil,
  isImminent,
  getNextEarnings,
  downgradeRecommendation,
  applyEarningsAdjustment,
} from "@/lib/earnings";
import type { Analysis } from "@/types";

const NOW = new Date("2026-04-27T12:00:00Z");

function makeAnalysis(overrides: Partial<Analysis> = {}): Analysis {
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

describe("daysUntil", () => {
  it("returns 0 for same day", () => {
    expect(daysUntil("2026-04-27", new Date("2026-04-27T15:00:00Z"))).toBe(0);
  });

  it("returns positive for future, negative for past", () => {
    expect(daysUntil("2026-05-01", NOW)).toBe(4);
    expect(daysUntil("2026-04-20", NOW)).toBe(-7);
  });

  it("returns NaN on invalid input", () => {
    expect(Number.isNaN(daysUntil("not-a-date", NOW))).toBe(true);
  });

  it("handles Date instances directly", () => {
    expect(daysUntil(new Date("2026-04-30"), NOW)).toBe(3);
  });
});

describe("isImminent", () => {
  it("true within window", () => {
    expect(isImminent("2026-04-30", NOW)).toBe(true); // 3 days
    expect(isImminent("2026-05-04", NOW)).toBe(true); // 7 days (boundary)
  });

  it("false outside window", () => {
    expect(isImminent("2026-05-08", NOW)).toBe(false);
  });

  it("false in the past", () => {
    expect(isImminent("2026-04-20", NOW)).toBe(false);
  });

  it("false on invalid input", () => {
    expect(isImminent("not-a-date", NOW)).toBe(false);
  });
});

describe("getNextEarnings", () => {
  it("returns null for empty list", () => {
    expect(getNextEarnings([], NOW)).toBeNull();
  });

  it("picks the closest future event", () => {
    const r = getNextEarnings(
      [
        { date: "2026-06-01" },
        { date: "2026-04-29" },
        { date: "2026-04-20" },
      ],
      NOW
    );
    expect(r?.nextDate).toBe("2026-04-29");
    expect(r?.daysUntil).toBe(2);
    expect(r?.imminent).toBe(true);
  });

  it("ignores past events", () => {
    const r = getNextEarnings(
      [{ date: "2026-04-20" }, { date: "2026-04-15" }],
      NOW
    );
    expect(r).toBeNull();
  });

  it("flags imminent vs distant", () => {
    expect(getNextEarnings([{ date: "2026-04-30" }], NOW)?.imminent).toBe(true);
    expect(getNextEarnings([{ date: "2026-05-30" }], NOW)?.imminent).toBe(false);
  });

  it("ignores invalid dates", () => {
    const r = getNextEarnings(
      [{ date: "not-real" }, { date: "2026-04-30" }],
      NOW
    );
    expect(r?.nextDate).toBe("2026-04-30");
  });

  it("propagates eps + hour", () => {
    const r = getNextEarnings(
      [{ date: "2026-04-30", epsEstimate: 1.25, hour: "amc" }],
      NOW
    );
    expect(r?.epsEstimate).toBe(1.25);
    expect(r?.hour).toBe("amc");
  });
});

describe("downgradeRecommendation", () => {
  it("walks down by one tier", () => {
    expect(downgradeRecommendation("STRONG BUY")).toBe("BUY");
    expect(downgradeRecommendation("BUY")).toBe("HOLD");
    expect(downgradeRecommendation("HOLD")).toBe("SELL");
    expect(downgradeRecommendation("SELL")).toBe("STRONG SELL");
  });

  it("STRONG SELL stays STRONG SELL (floor)", () => {
    expect(downgradeRecommendation("STRONG SELL")).toBe("STRONG SELL");
  });
});

describe("applyEarningsAdjustment", () => {
  it("returns input unchanged when earnings is null", () => {
    const a = makeAnalysis();
    expect(applyEarningsAdjustment(a, null)).toBe(a);
  });

  it("attaches non-imminent earnings without nudging score/recommendation", () => {
    const a = makeAnalysis({ compositeScore: 30, recommendation: "BUY" });
    const r = applyEarningsAdjustment(a, {
      nextDate: "2026-06-01",
      daysUntil: 35,
      imminent: false,
    });
    expect(r.compositeScore).toBe(30);
    expect(r.recommendation).toBe("BUY");
    expect(r.earnings?.nextDate).toBe("2026-06-01");
    expect(r.signals).toEqual(a.signals); // no signal added
  });

  it("nudges score, downgrades recommendation, adds signal when imminent", () => {
    const a = makeAnalysis({ compositeScore: 50, recommendation: "STRONG BUY" });
    const r = applyEarningsAdjustment(a, {
      nextDate: "2026-04-30",
      daysUntil: 3,
      imminent: true,
    });
    expect(r.compositeScore).toBe(25); // 50 + (-25)
    expect(r.recommendation).toBe("BUY"); // downgraded one tier
    expect(r.signals.some((s) => s.label === "Earnings Imminent")).toBe(true);
  });

  it("clamps the nudged score to [-100, 100]", () => {
    const a = makeAnalysis({ compositeScore: -90, recommendation: "STRONG SELL" });
    const r = applyEarningsAdjustment(a, {
      nextDate: "2026-04-30",
      daysUntil: 3,
      imminent: true,
    });
    expect(r.compositeScore).toBe(-100);
  });

  it("uses singular 'day' when daysUntil === 1", () => {
    const a = makeAnalysis();
    const r = applyEarningsAdjustment(a, {
      nextDate: "2026-04-28",
      daysUntil: 1,
      imminent: true,
    });
    const sig = r.signals.find((s) => s.label === "Earnings Imminent");
    expect(sig?.detail).toContain("1 day —");
  });

  it("respects applyRecommendationDowngrade=false", () => {
    const a = makeAnalysis({ compositeScore: 50, recommendation: "STRONG BUY" });
    const r = applyEarningsAdjustment(
      a,
      { nextDate: "2026-04-30", daysUntil: 3, imminent: true },
      {
        imminenceCalendarDays: 7,
        scoreAdjustment: -25,
        applyRecommendationDowngrade: false,
        refreshIntervalMs: 0,
        fetchHorizonDays: 30,
      }
    );
    expect(r.recommendation).toBe("STRONG BUY");
  });

  it("does not mutate the input analysis", () => {
    const a = makeAnalysis({ compositeScore: 50, recommendation: "STRONG BUY" });
    applyEarningsAdjustment(a, {
      nextDate: "2026-04-30",
      daysUntil: 3,
      imminent: true,
    });
    expect(a.compositeScore).toBe(50);
    expect(a.recommendation).toBe("STRONG BUY");
    expect(a.signals).toEqual([]);
  });
});
