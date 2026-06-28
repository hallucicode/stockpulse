import { describe, it, expect } from "vitest";
import {
  computeAvgDollarVolume,
  computeSpread,
  simulateMarketBuyFill,
  simulateStopTargetExit,
  type BacktestBar,
} from "@/lib/backtest-execution";
import { BACKTEST_CONFIG } from "@/lib/config";

function bar(
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number = 1_000_000
): BacktestBar {
  return { open, high, low, close, volume };
}

describe("computeSpread", () => {
  it("returns lowSpreadPct (liquid tier) at or above the high-volume threshold", () => {
    expect(computeSpread(BACKTEST_CONFIG.highVolumeDollarThreshold)).toBe(
      BACKTEST_CONFIG.lowSpreadPct
    );
    expect(
      computeSpread(BACKTEST_CONFIG.highVolumeDollarThreshold * 10)
    ).toBe(BACKTEST_CONFIG.lowSpreadPct);
  });

  it("returns highSpreadPct (illiquid tier) at or below the low-volume threshold", () => {
    expect(computeSpread(BACKTEST_CONFIG.lowVolumeDollarThreshold)).toBe(
      BACKTEST_CONFIG.highSpreadPct
    );
    expect(
      computeSpread(BACKTEST_CONFIG.lowVolumeDollarThreshold / 10)
    ).toBe(BACKTEST_CONFIG.highSpreadPct);
  });

  it("linearly interpolates between the two tiers", () => {
    const mid =
      (BACKTEST_CONFIG.lowVolumeDollarThreshold +
        BACKTEST_CONFIG.highVolumeDollarThreshold) /
      2;
    const midSpread =
      (BACKTEST_CONFIG.lowSpreadPct + BACKTEST_CONFIG.highSpreadPct) / 2;
    expect(computeSpread(mid)).toBeCloseTo(midSpread, 10);
  });

  it("defensively returns highSpreadPct for zero / negative / NaN volume", () => {
    expect(computeSpread(0)).toBe(BACKTEST_CONFIG.highSpreadPct);
    expect(computeSpread(-100)).toBe(BACKTEST_CONFIG.highSpreadPct);
    expect(computeSpread(NaN)).toBe(BACKTEST_CONFIG.highSpreadPct);
  });
});

describe("computeAvgDollarVolume", () => {
  it("returns 0 for an empty series", () => {
    expect(computeAvgDollarVolume([])).toBe(0);
  });

  it("averages close × volume across the trailing window", () => {
    const bars = [
      bar(0, 0, 0, 100, 1_000_000),
      bar(0, 0, 0, 200, 1_000_000),
      bar(0, 0, 0, 50, 2_000_000),
    ];
    // (100 × 1e6 + 200 × 1e6 + 50 × 2e6) / 3 = (100 + 200 + 100) / 3 × 1e6
    // = 400 / 3 × 1e6 ≈ 133.33M
    expect(computeAvgDollarVolume(bars)).toBeCloseTo(
      ((100 + 200 + 100) / 3) * 1_000_000,
      0
    );
  });

  it("only uses the last `lookback` bars", () => {
    const bars = [
      bar(0, 0, 0, 1000, 1_000_000), // should be excluded
      bar(0, 0, 0, 100, 1_000_000),
      bar(0, 0, 0, 100, 1_000_000),
    ];
    expect(computeAvgDollarVolume(bars, 2)).toBe(100 * 1_000_000);
  });
});

describe("simulateMarketBuyFill", () => {
  it("fills at bar.high plus half-spread", () => {
    const fill = simulateMarketBuyFill({
      bar: bar(100, 105, 99, 102),
      spreadPct: 0.002, // 20 bps
    });
    // 105 × (1 + 0.001) = 105.105
    expect(fill).toBeCloseTo(105.105, 6);
  });

  it("equals bar.high when spread is zero (sanity check)", () => {
    expect(
      simulateMarketBuyFill({ bar: bar(100, 110, 90, 105), spreadPct: 0 })
    ).toBe(110);
  });
});

describe("simulateStopTargetExit", () => {
  it("gap-down through stop → fills at gap-open, reason=stop", () => {
    // Stop at 95, but bar opens at 90.
    const r = simulateStopTargetExit({
      bar: bar(90, 92, 88, 91),
      stopPrice: 95,
      targetPrice: 110,
      spreadPct: 0,
    });
    expect(r.reason).toBe("stop");
    expect(r.price).toBe(90);
  });

  it("intraday low pierces stop → fills at stop, reason=stop", () => {
    // Open above stop, low touches 94 (below stop=95).
    const r = simulateStopTargetExit({
      bar: bar(100, 101, 94, 99),
      stopPrice: 95,
      targetPrice: 110,
      spreadPct: 0,
    });
    expect(r.reason).toBe("stop");
    expect(r.price).toBe(95);
  });

  it("intraday high reaches target → fills at target, reason=target", () => {
    const r = simulateStopTargetExit({
      bar: bar(100, 111, 99, 108),
      stopPrice: 95,
      targetPrice: 110,
      spreadPct: 0,
    });
    expect(r.reason).toBe("target");
    expect(r.price).toBe(110);
  });

  it("both stop and target reachable in same bar → stop wins (conservative)", () => {
    // Bar swings from 94 to 111 — both inside.
    const r = simulateStopTargetExit({
      bar: bar(100, 111, 94, 105),
      stopPrice: 95,
      targetPrice: 110,
      spreadPct: 0,
    });
    expect(r.reason).toBe("stop");
    expect(r.price).toBe(95);
  });

  it("position stays open when neither stop nor target hit", () => {
    const r = simulateStopTargetExit({
      bar: bar(100, 109, 96, 105),
      stopPrice: 95,
      targetPrice: 110,
      spreadPct: 0,
    });
    expect(r.reason).toBeNull();
    expect(r.price).toBeNull();
  });

  it("applies half-spread on the bid side when exiting", () => {
    const r = simulateStopTargetExit({
      bar: bar(100, 110, 99, 105),
      stopPrice: 95,
      targetPrice: 110,
      spreadPct: 0.002, // 20 bps
    });
    // Target hit at 110, sold for 110 × (1 - 0.001) = 109.89
    expect(r.reason).toBe("target");
    expect(r.price).toBeCloseTo(109.89, 6);
  });

  it("gap-down with spread applied", () => {
    const r = simulateStopTargetExit({
      bar: bar(80, 82, 78, 81),
      stopPrice: 95,
      targetPrice: 110,
      spreadPct: 0.01,
    });
    expect(r.reason).toBe("stop");
    expect(r.price).toBeCloseTo(80 * 0.995, 6);
  });
});
