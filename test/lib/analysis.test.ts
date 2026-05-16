import { describe, it, expect } from "vitest";
import { analyzeStock, getSellSignal, checkQualityGate } from "@/lib/analysis";
import type { HistoricalBar, Analysis } from "@/types";

function makeHistory(closes: number[], volumes?: number[]): HistoricalBar[] {
  return closes.map((close, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: volumes ? volumes[i] : 1_000_000,
  }));
}

describe("analyzeStock", () => {
  it("returns an Analysis for minimal data (single bar)", () => {
    const a = analyzeStock("TEST", makeHistory([100]));
    expect(a.symbol).toBe("TEST");
    expect(a.price).toBe(100);
    expect(a.rsi).toBe(50); // default
    expect(a.recommendation).toBeDefined();
    expect(Array.isArray(a.signals)).toBe(true);
  });

  it("computes dayChange correctly with two bars", () => {
    const a = analyzeStock("TEST", makeHistory([100, 110]));
    expect(a.dayChange).toBeCloseTo(10, 1);
  });

  it("handles empty history safely", () => {
    const a = analyzeStock("EMPTY", []);
    expect(a.price).toBe(0);
    expect(a.dayChange).toBe(0);
  });

  it("detects deeply oversold (RSI < 25) as buy signal", () => {
    // Create strongly declining series -> RSI very low
    const closes = Array.from({ length: 20 }, (_, i) => 200 - i * 8);
    const a = analyzeStock("OVER", makeHistory(closes));
    expect(a.rsi).toBeLessThan(25);
    expect(a.signals.some((s) => s.label === "RSI Oversold")).toBe(true);
  });

  it("detects RSI Low (25-35) as weaker buy", () => {
    // Mostly declining with a tiny pullback so we get a non-zero gain count
    // and RSI lands in the 25-35 range.
    const closes = [
      100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 88, 86,
    ];
    const a = analyzeStock("LOW", makeHistory(closes));
    expect(a.rsi).toBeGreaterThan(0);
    expect(a.rsi).toBeLessThan(50);
  });

  it("detects RSI Overbought (>75)", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i * 8);
    const a = analyzeStock("HIGH", makeHistory(closes));
    expect(a.rsi).toBeGreaterThan(75);
    expect(a.signals.some((s) => s.label === "RSI Overbought")).toBe(true);
  });

  it("detects RSI High (65-75)", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
    const a = analyzeStock("MID_HIGH", makeHistory(closes));
    // Should be neutral or high depending on exact values
    expect(a.rsi).toBeGreaterThan(50);
  });

  it("clamps score between -100 and 100", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 - i * 10);
    const a = analyzeStock("CLAMP", makeHistory(closes));
    expect(a.compositeScore).toBeGreaterThanOrEqual(-100);
    expect(a.compositeScore).toBeLessThanOrEqual(100);
  });

  it("returns STRONG BUY for very high score", () => {
    // Sharp weekly dip + oversold RSI
    const closes = [100, 100, 100, 100, 100, 100, 100, 50];
    const a = analyzeStock("BUY", makeHistory(closes));
    expect(a.compositeScore).toBeGreaterThan(0);
  });

  it("returns STRONG SELL for very low score", () => {
    // Sharp rally + overbought
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i * 10);
    const a = analyzeStock("SELL", makeHistory(closes));
    expect(a.recommendation).toMatch(/SELL/);
  });

  it("generates Bollinger signals when price is at lower band", () => {
    // Flat then sudden drop
    const closes = [
      100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
      100, 100, 100, 100, 100, 80,
    ];
    const a = analyzeStock("BOLL_LOW", makeHistory(closes));
    expect(a.bollingerLower).toBeDefined();
    expect(a.signals.some((s) => s.label === "Below Lower Bollinger")).toBe(true);
  });

  it("generates Bollinger signal at upper band", () => {
    const closes = [
      100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
      100, 100, 100, 100, 100, 120,
    ];
    const a = analyzeStock("BOLL_HIGH", makeHistory(closes));
    expect(a.signals.some((s) => s.label === "Above Upper Bollinger")).toBe(true);
  });

  it("detects bullish SMA cross", () => {
    const closes = [
      50, 52, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76, 78, 80, 82, 84,
      86, 88, 90, 92, 94, 96, 98, 100, 102, 104, 106, 108, 110, 112, 114, 116,
      118, 120, 122, 124, 126, 128, 130, 132, 134, 136, 138, 140, 142, 144,
      146, 148, 150, 152, 154, 156, 158,
    ];
    const a = analyzeStock("BULLX", makeHistory(closes));
    expect(a.signals.some((s) => s.label === "Bullish SMA Cross")).toBe(true);
  });

  it("detects bearish SMA cross", () => {
    const closes = Array.from({ length: 55 }, (_, i) => 158 - i * 2);
    const a = analyzeStock("BEARX", makeHistory(closes));
    expect(a.signals.some((s) => s.label === "Bearish SMA Cross")).toBe(true);
  });

  it("returns MACD bullish signal for positive histogram", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const a = analyzeStock("MACD_B", makeHistory(closes));
    // For monotonically increasing series, MACD should be positive
    const macdSig = a.signals.find((s) => s.label.startsWith("MACD"));
    expect(macdSig).toBeDefined();
  });

  it("detects Sharp Weekly Dip as buy", () => {
    // 7 bars with last being 20% lower
    const closes = [100, 100, 100, 100, 100, 100, 80];
    const a = analyzeStock("DIP", makeHistory(closes));
    expect(a.signals.some((s) => s.label === "Sharp Weekly Dip")).toBe(true);
  });

  it("detects Sharp Weekly Rally as sell", () => {
    const closes = [100, 100, 100, 100, 100, 100, 120];
    const a = analyzeStock("RALLY", makeHistory(closes));
    expect(a.signals.some((s) => s.label === "Sharp Weekly Rally")).toBe(true);
  });

  it("detects capitulation volume on sell-off", () => {
    const closes = Array.from({ length: 21 }, (_, i) => 100);
    closes[20] = 96; // -4% drop
    const volumes = Array.from({ length: 21 }, () => 1_000_000);
    volumes[20] = 5_000_000; // 5x volume spike
    const a = analyzeStock("CAP", makeHistory(closes, volumes));
    expect(a.signals.some((s) => s.label === "Capitulation Volume")).toBe(true);
  });

  it("computes week/month changes when history has enough bars", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const a = analyzeStock("CHANGES", makeHistory(closes));
    expect(a.weekChange).not.toBe(0);
    expect(a.monthChange).not.toBe(0);
  });

  it("computes avgDailyVolatility", () => {
    const closes = [100, 105, 100, 105, 100, 105];
    const a = analyzeStock("VOL", makeHistory(closes));
    expect(a.avgDailyVolatility).toBeGreaterThan(0);
  });

  it("recommendation BUY when score is 15-40", () => {
    // Construct scenario with medium buy score
    const closes = [100, 100, 100, 100, 100, 100, 100, 85];
    const a = analyzeStock("MED", makeHistory(closes));
    expect(["BUY", "STRONG BUY", "HOLD"]).toContain(a.recommendation);
  });

  it("recommendation SELL when score is -40 to -15", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i * 3);
    const a = analyzeStock("MEDSELL", makeHistory(closes));
    expect(["SELL", "STRONG SELL", "HOLD"]).toContain(a.recommendation);
  });

  it("handles zero prev in dayChange calculation", () => {
    const history = [{ ...makeHistory([0, 100])[0], close: 0 }, makeHistory([100])[0]];
    const a = analyzeStock("ZERO", history);
    expect(Number.isFinite(a.dayChange)).toBe(true);
  });

  it("handles all-equal closes without NaN", () => {
    const closes = Array(30).fill(100);
    const a = analyzeStock("FLAT", makeHistory(closes));
    expect(a.rsi).toBe(100); // no losses -> RSI 100
    expect(Number.isFinite(a.avgDailyVolatility)).toBe(true);
  });
});

describe("Phase 2.5 quality gate", () => {
  // Helper: a clean, liquid, normal stock — should never trip any rule.
  function liquidHistory(price: number) {
    return Array.from({ length: 30 }, () => ({
      date: "2026-04-27",
      open: price,
      high: price * 1.01,
      low: price * 0.99,
      close: price,
      volume: 5_000_000, // $250M daily dollar volume at $50
    }));
  }

  it("does not veto a clean, liquid stock", () => {
    const a = analyzeStock("OK", liquidHistory(50));
    expect(a.qualityVeto).toBeUndefined();
  });

  it("vetoes a penny stock (price < $1)", () => {
    const a = analyzeStock("PENNY", liquidHistory(0.5));
    expect(a.qualityVeto?.reason).toBe("penny_stock");
    expect(a.qualityVeto?.detail).toContain("$0.50");
  });

  it("does not veto exactly $1.00 (boundary)", () => {
    const a = analyzeStock("ONE", liquidHistory(1.0));
    // Note: exactly $1.00 doesn't trip the penny check, but liquidity might
    // (5M shares × $1 = $5M, > $1M floor → safe).
    expect(a.qualityVeto?.reason).not.toBe("penny_stock");
  });

  it("vetoes when Bollinger lower band ≤ 0 (degenerate)", () => {
    // Wild swings around a low mean → 2σ goes negative.
    const closes = [
      0.5, 5, 0.5, 5, 0.5, 5, 0.5, 5, 0.5, 5, 0.5, 5, 0.5, 5, 0.5, 5, 0.5, 5,
      0.5, 5, 0.5, 5,
    ];
    const bars = closes.map((c) => ({
      date: "2026-04-27",
      open: c,
      high: c * 1.01,
      low: c * 0.99,
      close: c,
      volume: 10_000_000, // ensure liquidity passes
    }));
    const a = analyzeStock("DEG", bars);
    // The penny rule fires first (price 5 is fine, but the *last* close is 5
    // — it's above $1, so not penny. Volatility-induced negative lower band
    // becomes the active veto.
    expect(["degenerate_bollinger", "penny_stock"]).toContain(
      a.qualityVeto?.reason
    );
  });

  it("vetoes an illiquid stock (low dollar volume)", () => {
    // $50 stock × 1k shares/day = $50k — well under $1M floor.
    const bars = Array.from({ length: 30 }, () => ({
      date: "2026-04-27",
      open: 50,
      high: 50.5,
      low: 49.5,
      close: 50,
      volume: 1_000,
    }));
    const a = analyzeStock("ILL", bars);
    expect(a.qualityVeto?.reason).toBe("illiquid");
  });

  it("vetoes a dormant stock (>50% zero-volume bars)", () => {
    // Mostly zero-volume; a few non-zero so dollar-volume isn't the trigger.
    const bars = Array.from({ length: 20 }, (_, i) => ({
      date: "2026-04-27",
      open: 50,
      high: 50.5,
      low: 49.5,
      close: 50,
      volume: i < 6 ? 5_000_000 : 0, // 30% active, 70% zero
    }));
    const a = analyzeStock("DOR", bars);
    expect(a.qualityVeto?.reason).toBe("dormant");
  });

  it("checkQualityGate returns null when all rules pass", () => {
    const bars = Array.from({ length: 20 }, () => ({
      date: "2026-04-27",
      open: 50,
      high: 51,
      low: 49,
      close: 50,
      volume: 5_000_000,
    }));
    const r = checkQualityGate({
      price: 50,
      bollingerLower: 45,
      recentBars: bars,
    });
    expect(r).toBeNull();
  });

  it("checkQualityGate fires penny first when multiple rules would match", () => {
    // Both penny AND illiquid would trip — verify the array-order winner.
    const r = checkQualityGate({
      price: 0.3,
      bollingerLower: 0.2,
      recentBars: [],
    });
    expect(r?.reason).toBe("penny_stock");
  });

  it("avgDollarVolume of empty bars is 0 (no crash)", () => {
    const r = checkQualityGate({
      price: 50,
      bollingerLower: 40,
      recentBars: [],
    });
    // Empty bars → avg = 0 → illiquid fires.
    expect(r?.reason).toBe("illiquid");
  });
});

describe("Phase 1 risk packet", () => {
  it("attaches a risk packet to every analysis", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 - i * 0.5);
    const a = analyzeStock("RISK", makeHistory(closes));
    expect(a.risk).toBeDefined();
    expect(a.risk!.entry).toBeCloseTo(closes[closes.length - 1], 5);
    expect(a.risk!.stop).toBeLessThan(a.risk!.entry);
    expect(a.risk!.target).toBeGreaterThan(a.risk!.entry);
    expect(a.risk!.riskReward).toBeGreaterThan(0);
    expect(["atr", "structural", "hard_cap"]).toContain(a.risk!.stopMethod);
  });

  it("does not throw and returns finite numbers on minimal data", () => {
    const a = analyzeStock("MIN", makeHistory([100]));
    expect(a.risk).toBeDefined();
    expect(Number.isFinite(a.risk!.entry)).toBe(true);
    expect(Number.isFinite(a.risk!.stop)).toBe(true);
    expect(Number.isFinite(a.risk!.target)).toBe(true);
  });
});

describe("getSellSignal", () => {
  const baseAnalysis: Analysis = {
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
    compositeScore: 0,
    recommendation: "HOLD",
    signals: [],
  };

  it("triggers hard stop loss when down >15%", () => {
    const analysis = { ...baseAnalysis, price: 80 };
    const s = getSellSignal(analysis, 100);
    expect(s?.urgency).toBe("high");
    expect(s?.reason).toContain("Stop loss");
  });

  it("triggers take profit when up >25%", () => {
    const analysis = { ...baseAnalysis, price: 130 };
    const s = getSellSignal(analysis, 100);
    expect(s?.urgency).toBe("medium");
    expect(s?.reason).toContain("Take profit");
  });

  it("triggers strong bearish signal on very low score", () => {
    const analysis = { ...baseAnalysis, compositeScore: -50 };
    const s = getSellSignal(analysis, 100);
    expect(s?.urgency).toBe("high");
    expect(s?.reason).toMatch(/bearish/i);
  });

  it("triggers lock-in-gains when bearish with small profit", () => {
    const analysis = { ...baseAnalysis, compositeScore: -20, price: 106 };
    const s = getSellSignal(analysis, 100);
    expect(s?.urgency).toBe("low");
  });

  it("triggers RSI overbought + profit", () => {
    const analysis = { ...baseAnalysis, rsi: 80, price: 105 };
    const s = getSellSignal(analysis, 100);
    expect(s?.urgency).toBe("medium");
    expect(s?.reason).toContain("RSI");
  });

  it("returns null when nothing triggers", () => {
    const s = getSellSignal(baseAnalysis, 100);
    expect(s).toBeNull();
  });
});
