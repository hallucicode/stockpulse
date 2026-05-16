import { describe, it, expect } from "vitest";
import {
  classifySectorRotation,
  attachSectorRotation,
} from "@/lib/sector-rotation";
import { SECTOR_ROTATION_CONFIG } from "@/lib/config";
import type { HistoricalBar, SectorRotationInfo } from "@/types";

// Tiny config so we can build fixtures with manageable bar counts. We
// shrink minPriorDownBars and smaPeriod but otherwise mirror prod shape.
const TEST_CFG = {
  refreshIntervalMs: 24 * 60 * 60 * 1000,
  historyDays: 60,
  smaPeriod: 10,
  minPriorDownBars: 8,
  maxRecentUpBars: 6,
  minPriorUpBars: 8,
  maxRecentDownBars: 6,
} as const;

function bar(close: number, i = 0): HistoricalBar {
  return {
    date: new Date(2026, 0, i + 1).toISOString().slice(0, 10),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000_000,
  };
}

// Use three distinct values for seed/prior/recent so the SMA never lands
// exactly on `close` (strict `<`/`>` predicates would otherwise miss the
// boundary bar). The seed pulls SMA up while the prior runs LOW, then the
// recent run jumps high enough that the trailing-up run is unambiguous.
const SEED = 100;
const LOW = 80;
const HIGH = 120;

/** Long downtrend (LOW after a higher seed), then a short up-burst.
 *  Recent phase uses a tiny upward drift so SMA never locks exactly on
 *  close (real prices drift; constant plateaus are a test artifact that
 *  collides with strict `>` predicates). */
function turningUpSeries(prior: number, recent: number): HistoricalBar[] {
  const bars: HistoricalBar[] = [];
  for (let i = 0; i < TEST_CFG.smaPeriod; i++) bars.push(bar(SEED, i));
  for (let i = 0; i < prior; i++) bars.push(bar(LOW, i + TEST_CFG.smaPeriod));
  for (let i = 0; i < recent; i++)
    bars.push(bar(HIGH + i, i + TEST_CFG.smaPeriod + prior));
  return bars;
}

/** Mirror of turningUpSeries — recent phase drifts down each bar. */
function turningDownSeries(prior: number, recent: number): HistoricalBar[] {
  const bars: HistoricalBar[] = [];
  for (let i = 0; i < TEST_CFG.smaPeriod; i++) bars.push(bar(SEED, i));
  for (let i = 0; i < prior; i++) bars.push(bar(HIGH, i + TEST_CFG.smaPeriod));
  for (let i = 0; i < recent; i++)
    bars.push(bar(LOW - i, i + TEST_CFG.smaPeriod + prior));
  return bars;
}

describe("classifySectorRotation", () => {
  it("returns null when there isn't enough history for SMA", () => {
    const bars: HistoricalBar[] = [bar(100, 0), bar(101, 1)];
    expect(classifySectorRotation(bars, TEST_CFG)).toBeNull();
  });

  it("detects turning_up after a long downtrend + short up-run", () => {
    // Prior length sits at smaPeriod-1 so the last prior bar's SMA window
    // still contains one seed bar (SMA strictly above LOW), giving a clean
    // strict-`<` run for `priorOppositeRunBars`.
    const bars = turningUpSeries(
      TEST_CFG.smaPeriod - 1,
      Math.max(1, TEST_CFG.maxRecentUpBars - 2)
    );
    const r = classifySectorRotation(bars, TEST_CFG);
    expect(r?.state).toBe("turning_up");
    expect(r?.recentRunBars).toBeGreaterThan(0);
    expect(r?.priorOppositeRunBars).toBeGreaterThanOrEqual(
      TEST_CFG.minPriorDownBars
    );
  });

  it("classifies as trending_up when the up-run exceeds the catalyst window", () => {
    const bars = turningUpSeries(
      TEST_CFG.smaPeriod - 1,
      TEST_CFG.maxRecentUpBars + 5
    );
    const r = classifySectorRotation(bars, TEST_CFG);
    expect(r?.state).toBe("trending_up");
  });

  it("classifies as flat when there's a short up-run without a prior downtrend", () => {
    // Seed at SEED for smaPeriod bars, then a short up-bump — only 3 bars
    // above SMA, no prior_below accumulated. Neither "turning" nor
    // "trending" thresholds are met.
    const bars: HistoricalBar[] = [];
    for (let i = 0; i < TEST_CFG.smaPeriod; i++) bars.push(bar(SEED, i));
    for (let i = 0; i < 3; i++) bars.push(bar(SEED + 5, i + TEST_CFG.smaPeriod));
    const r = classifySectorRotation(bars, TEST_CFG);
    expect(r?.state).toBe("flat");
  });

  it("detects turning_down (mirror of turning_up)", () => {
    const bars = turningDownSeries(
      TEST_CFG.smaPeriod - 1,
      Math.max(1, TEST_CFG.maxRecentDownBars - 2)
    );
    const r = classifySectorRotation(bars, TEST_CFG);
    expect(r?.state).toBe("turning_down");
  });

  it("classifies as trending_down when the down-run exceeds the window", () => {
    const bars = turningDownSeries(
      TEST_CFG.smaPeriod - 1,
      TEST_CFG.maxRecentDownBars + 5
    );
    const r = classifySectorRotation(bars, TEST_CFG);
    expect(r?.state).toBe("trending_down");
  });

  it("emits close + sma200 fields for the audit trail", () => {
    const bars = turningUpSeries(
      TEST_CFG.smaPeriod - 1,
      Math.max(1, TEST_CFG.maxRecentUpBars - 2)
    );
    const r = classifySectorRotation(bars, TEST_CFG);
    // Recent phase has a tiny upward drift; last close = HIGH + (recent - 1).
    expect(r?.close).toBeGreaterThanOrEqual(HIGH);
    expect(r?.sma200).toBeGreaterThan(0);
  });

  it("is pure — same input twice yields the same classification", () => {
    const bars = turningUpSeries(TEST_CFG.smaPeriod - 1, 1);
    expect(classifySectorRotation(bars, TEST_CFG)).toEqual(
      classifySectorRotation(bars, TEST_CFG)
    );
  });

  it("default config also classifies a fabricated long-flat-then-cross series", () => {
    // Use real config; just feed enough bars (320+).
    const bars: HistoricalBar[] = [];
    const cfg = SECTOR_ROTATION_CONFIG;
    for (let i = 0; i < cfg.smaPeriod; i++) bars.push(bar(100, i));
    for (let i = 0; i < cfg.minPriorDownBars + 5; i++)
      bars.push(bar(90, i + cfg.smaPeriod));
    for (let i = 0; i < 3; i++)
      bars.push(bar(110, i + cfg.smaPeriod + cfg.minPriorDownBars + 5));
    const r = classifySectorRotation(bars);
    // The SMA at the very end of the series may still be pulled down by
    // the long below-period — accept either turning_up or flat, but the
    // CALL must not crash and must return a valid state.
    expect(r).not.toBeNull();
    expect([
      "turning_up",
      "trending_up",
      "flat",
      "trending_down",
      "turning_down",
    ]).toContain(r!.state);
  });
});

describe("attachSectorRotation", () => {
  const info: SectorRotationInfo = {
    state: "turning_up",
    etfSymbol: "XLK",
    close: 200,
    sma200: 190,
    recentRunBars: 4,
  };

  it("attaches info on a fresh object (no mutation)", () => {
    const input = { symbol: "AAPL", compositeScore: 30 } as const;
    const out = attachSectorRotation(input, info);
    expect(out.sectorRotation).toBe(info);
    expect((input as { sectorRotation?: unknown }).sectorRotation).toBeUndefined();
  });

  it("returns the original input unchanged when info is null", () => {
    const input = { symbol: "AAPL" } as const;
    const out = attachSectorRotation(input, null);
    expect(out).toBe(input);
  });
});
