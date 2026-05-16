import { describe, it, expect } from "vitest";
import {
  calcATR,
  findSwingLow,
  computeStop,
  computeTarget,
  computeRiskReward,
  computeSize,
  applyGuardrails,
  deriveRiskLevels,
} from "@/lib/risk";
import type { HistoricalBar } from "@/types";

function bar(
  close: number,
  high = close + 1,
  low = close - 1,
  volume = 1_000_000
): HistoricalBar {
  return {
    date: "2026-01-01",
    open: close,
    high,
    low,
    close,
    volume,
  };
}

function makeBars(closes: number[]): HistoricalBar[] {
  return closes.map((c) => bar(c));
}

describe("calcATR", () => {
  it("returns 0 for fewer than 2 bars", () => {
    expect(calcATR([])).toBe(0);
    expect(calcATR([bar(100)])).toBe(0);
  });

  it("computes simple ATR over a flat history", () => {
    // 5 bars, every bar high-low = 2, no overnight gaps → TR = 2 each
    const bars = makeBars([100, 100, 100, 100, 100]);
    expect(calcATR(bars, 4)).toBe(2);
  });

  it("uses gap component when |high - prevClose| > intra-bar range", () => {
    // bar1 close=100, bar2 high=110 low=108 → gap 10 > range 2
    const bars: HistoricalBar[] = [
      bar(100),
      { ...bar(109, 110, 108) },
    ];
    // TR for bar 2 = max(2, |110-100|=10, |108-100|=8) = 10
    expect(calcATR(bars)).toBe(10);
  });

  it("respects period when more bars than period", () => {
    const bars = [
      ...makeBars([100, 100, 100, 100, 100]), // TR=2 each
      bar(100, 105, 99), // TR > prev — let's say 5
    ];
    // With period=2, only the last 2 TRs are averaged.
    const atr = calcATR(bars, 2);
    expect(atr).toBeGreaterThan(0);
    expect(atr).toBeLessThan(10);
  });
});

describe("findSwingLow", () => {
  it("returns 0 on empty history", () => {
    expect(findSwingLow([])).toBe(0);
  });

  it("returns the lowest low in the lookback window", () => {
    const bars = [bar(100, 102, 98), bar(101, 103, 95), bar(102, 104, 99)];
    expect(findSwingLow(bars, 3)).toBe(95);
  });

  it("ignores bars before the lookback window", () => {
    const bars = [bar(100, 102, 50), bar(101, 103, 99), bar(102, 104, 100)];
    expect(findSwingLow(bars, 2)).toBe(99); // only last 2 considered
  });
});

describe("computeStop", () => {
  it("picks the tightest (highest) of three candidates", () => {
    // entry=100, ATR=3 → atrStop=94
    // swingLow=98 → structuralStop=97.02
    // hardCap=92
    // Tightest = 97.02 (structural)
    const s = computeStop(100, 3, 98);
    expect(s.method).toBe("structural");
    expect(s.price).toBeCloseTo(97.02, 2);
  });

  it("falls back to hard cap when other methods give wider stops", () => {
    // entry=100, ATR=10 → atrStop=80
    // swingLow=70 → structuralStop=69.3
    // hardCap=92 (tightest)
    const s = computeStop(100, 10, 70);
    expect(s.method).toBe("hard_cap");
    expect(s.price).toBe(92);
  });

  it("uses ATR when both ATR and structural are wider than hard cap", () => {
    // entry=100, ATR=2 → atrStop=96
    // swingLow=80 → structuralStop=79.2
    // hardCap=92
    const s = computeStop(100, 2, 80);
    expect(s.method).toBe("atr");
    expect(s.price).toBe(96);
  });
});

describe("computeTarget", () => {
  it("computes 3R target by default", () => {
    expect(computeTarget(100, 95)).toBe(115); // 100 + 5*3
  });

  it("respects custom ratio", () => {
    expect(computeTarget(100, 95, 2)).toBe(110);
  });
});

describe("computeRiskReward", () => {
  it("returns ratio of reward to risk", () => {
    expect(computeRiskReward(100, 95, 115)).toBe(3);
  });

  it("returns 0 for non-positive risk", () => {
    expect(computeRiskReward(100, 100, 110)).toBe(0);
    expect(computeRiskReward(100, 110, 120)).toBe(0); // stop > entry
  });
});

describe("computeSize", () => {
  it("sizes by 1% risk by default", () => {
    // portfolio=10000, entry=100, stop=95 → riskPerShare=5
    // riskBudget = 100 → shares = 20
    const r = computeSize({ portfolioValue: 10000, entry: 100, stop: 95 });
    expect(r.shares).toBe(20);
    expect(r.dollarRisk).toBe(100);
    expect(r.positionValue).toBe(2000);
    expect(r.positionPct).toBe(0.2);
  });

  it("respects custom riskPct", () => {
    const r = computeSize({
      portfolioValue: 10000,
      entry: 100,
      stop: 95,
      riskPct: 0.005,
    });
    expect(r.shares).toBe(10);
  });

  it("returns zeros for degenerate inputs", () => {
    expect(computeSize({ portfolioValue: 0, entry: 100, stop: 95 }).shares).toBe(0);
    expect(computeSize({ portfolioValue: 1000, entry: 100, stop: 100 }).shares).toBe(0);
    expect(computeSize({ portfolioValue: 1000, entry: 100, stop: 110 }).shares).toBe(0);
    expect(
      computeSize({ portfolioValue: 1000, entry: 100, stop: 95, riskPct: 0 }).shares
    ).toBe(0);
    expect(
      computeSize({ portfolioValue: 1000, entry: NaN, stop: 95 }).shares
    ).toBe(0);
  });

  it("floors share count (no fractional shares)", () => {
    // riskBudget = 100, riskPerShare = 7 → 14.28 → 14
    const r = computeSize({ portfolioValue: 10000, entry: 100, stop: 93 });
    expect(r.shares).toBe(14);
  });
});

describe("applyGuardrails", () => {
  const portfolioValue = 10000;

  it("passes through when within all caps", () => {
    const r = applyGuardrails({
      candidate: { symbol: "AAA", sector: "Tech", shares: 5, entry: 100 }, // $500 = 5%
      portfolioValue,
      currentPositions: [],
    });
    expect(r.shares).toBe(5);
    expect(r.reason).toBeUndefined();
  });

  it("trims to single-position cap (10%)", () => {
    const r = applyGuardrails({
      candidate: { symbol: "AAA", sector: "Tech", shares: 20, entry: 100 }, // $2000 = 20%
      portfolioValue,
      currentPositions: [],
    });
    expect(r.shares).toBe(10); // capped at $1000
    expect(r.reason).toBe("single-position cap");
  });

  it("trims to sector cap (25%)", () => {
    // existing tech = $2000 (20%), candidate adds $1000 → 30% > 25%
    // allowedAdd = 500 → shares = 5
    const r = applyGuardrails({
      candidate: { symbol: "BBB", sector: "Tech", shares: 10, entry: 100 },
      portfolioValue,
      currentPositions: [{ symbol: "AAA", sector: "Tech", value: 2000 }],
    });
    expect(r.shares).toBe(5);
    expect(r.reason).toBe("sector cap");
  });

  it("zeroes shares when sector already at cap", () => {
    const r = applyGuardrails({
      candidate: { symbol: "BBB", sector: "Tech", shares: 1, entry: 100 },
      portfolioValue,
      currentPositions: [{ symbol: "AAA", sector: "Tech", value: 2500 }],
    });
    expect(r.shares).toBe(0);
    expect(r.reason).toMatch(/sector cap/);
  });

  it("zeroes shares when single-cap math goes below 1 share", () => {
    // entry > maxPositionValue means max trims to 0
    const r = applyGuardrails({
      candidate: { symbol: "X", sector: "Tech", shares: 1, entry: 5000 }, // $5000 vs $1000 cap
      portfolioValue,
      currentPositions: [],
    });
    expect(r.shares).toBe(0);
    expect(r.reason).toBe("single-position cap");
  });

  it("zeroes shares when sector cap allows < 1 share", () => {
    // existing = $2400. cap = $2500. allowedAdd = $100. entry = $200.
    // shares = floor(100/200) = 0
    const r = applyGuardrails({
      candidate: { symbol: "B", sector: "Tech", shares: 1, entry: 200 },
      portfolioValue,
      currentPositions: [{ symbol: "A", sector: "Tech", value: 2400 }],
    });
    expect(r.shares).toBe(0);
    expect(r.reason).toBe("sector cap reached");
  });

  it("rejects degenerate inputs", () => {
    const base = {
      symbol: "X",
      sector: "T",
      shares: 1,
      entry: 100,
    };
    expect(
      applyGuardrails({
        candidate: base,
        portfolioValue: 0,
        currentPositions: [],
      }).shares
    ).toBe(0);
    expect(
      applyGuardrails({
        candidate: { ...base, entry: 0 },
        portfolioValue,
        currentPositions: [],
      }).shares
    ).toBe(0);
    expect(
      applyGuardrails({
        candidate: { ...base, shares: 0 },
        portfolioValue,
        currentPositions: [],
      }).shares
    ).toBe(0);
  });
});

describe("deriveRiskLevels", () => {
  it("returns zeroed packet for empty history", () => {
    const r = deriveRiskLevels([]);
    expect(r.entry).toBe(0);
    expect(r.atr).toBe(0);
    expect(r.riskReward).toBe(0);
  });

  it("produces a sensible packet from real-shaped history", () => {
    // 30 bars, declining gently then leveling — typical buyable setup.
    const closes = Array.from({ length: 30 }, (_, i) =>
      i < 15 ? 100 - i : 85 + (i - 15) * 0.2
    );
    const bars = closes.map((c) => bar(c, c + 1, c - 1));
    const r = deriveRiskLevels(bars);
    expect(r.entry).toBeGreaterThan(0);
    expect(r.stop).toBeLessThan(r.entry);
    expect(r.target).toBeGreaterThan(r.entry);
    expect(r.riskReward).toBeGreaterThan(0);
    expect(["atr", "structural", "hard_cap"]).toContain(r.stopMethod);
  });
});
