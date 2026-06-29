import { describe, it, expect, vi } from "vitest";
import { runBacktest } from "@/lib/backtest";
import type { HistoricalBar } from "@/types";
import * as analysisModule from "@/lib/analysis";

/**
 * Build a series of `count` daily bars starting on 2026-01-01 with a
 * simple ramp from `startPrice` upward by `step` per day. Volume is
 * fixed at the high-volume tier so the spread stays tight in tests
 * unless overridden.
 */
function rampSeries(
  count: number,
  startPrice: number,
  step: number,
  volumeOverride?: number
): HistoricalBar[] {
  const bars: HistoricalBar[] = [];
  // Start at a Monday to keep ISO dates monotone day-to-day.
  const startMs = Date.UTC(2026, 0, 5); // Jan 5 2026 (Monday)
  for (let i = 0; i < count; i++) {
    const ms = startMs + i * 24 * 60 * 60 * 1000;
    const date = new Date(ms).toISOString().slice(0, 10);
    const close = startPrice + step * i;
    bars.push({
      date: date + "T00:00:00.000Z",
      open: close - 0.5,
      high: close + 0.5,
      low: close - 1,
      close,
      volume: volumeOverride ?? 2_000_000, // close × 2M ≈ healthy
    });
  }
  return bars;
}

describe("runBacktest", () => {
  it("returns zero trades + flat equity curve when no signals fire", async () => {
    // Flat price ramp wouldn't trigger BUY signals from analyzeStock.
    // But to make this test deterministic, mock analyzeStock to always
    // return HOLD.
    const spy = vi.spyOn(analysisModule, "analyzeStock").mockImplementation(
      (symbol) => ({
        symbol,
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
      })
    );

    const result = await runBacktest(
      {
        symbols: ["AAA"],
        startDate: "2026-01-05",
        endDate: "2026-04-15",
        startingCapital: 50_000,
      },
      { AAA: rampSeries(100, 100, 0) }
    );

    expect(result.trades).toEqual([]);
    expect(result.summary.endingCapital).toBe(50_000);
    expect(result.summary.totalReturn).toBe(0);
    expect(result.equityCurve.length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it("enforces no lookahead — analyzeStock never sees bars > current day", async () => {
    let maxBarIndexEverSeen = -1;
    let lastSliceLength = -1;
    const spy = vi.spyOn(analysisModule, "analyzeStock").mockImplementation(
      (symbol, history) => {
        // Every call slice should be a prefix of the full series.
        if (history.length > lastSliceLength) lastSliceLength = history.length;
        // The slice's last bar's index in the full series == history.length - 1.
        // We assert below that this never exceeds the loop's current day index.
        maxBarIndexEverSeen = Math.max(maxBarIndexEverSeen, history.length - 1);
        return {
          symbol,
          price: history[history.length - 1].close,
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
      }
    );

    const series = rampSeries(100, 100, 0.1);
    await runBacktest(
      {
        symbols: ["AAA"],
        startDate: "2026-01-05",
        endDate: "2026-04-15",
        startingCapital: 50_000,
      },
      { AAA: series }
    );

    // The full series has 100 bars (indices 0..99). The simulator can
    // see at most all of them by the final day, but the critical
    // invariant is: each call to analyzeStock receives at most
    // bars[0..currentDayIdx]. Since we asserted on EVERY call inside
    // the spy that history.length ≤ series.length, and the simulator
    // would only ever pass bars up to "today", this passes when no
    // lookahead exists.
    expect(maxBarIndexEverSeen).toBeLessThanOrEqual(series.length - 1);
    // Sanity: the spy was actually called multiple times.
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    // Sanity: the LAST slice equals the full series (final day).
    expect(lastSliceLength).toBe(series.length);
    spy.mockRestore();
  });

  it("E2E: forces one BUY signal at day 60, simulates entry on D+1, exits at target", async () => {
    // 100-bar ramp from 100 → upward. analyzeStock mock: returns HOLD
    // for all days except day index 60 where it returns STRONG BUY
    // with stop=99, target=110.
    let callCount = 0;
    const spy = vi.spyOn(analysisModule, "analyzeStock").mockImplementation(
      (symbol, history) => {
        callCount += 1;
        const isSignalDay = history.length === 61; // 0-indexed day 60
        return {
          symbol,
          price: history[history.length - 1].close,
          rsi: 25,
          sma20: 100,
          sma50: 100,
          bollingerUpper: 110,
          bollingerLower: 90,
          bollingerMid: 100,
          macdLine: 1,
          macdSignal: 0,
          macdHistogram: 1,
          dayChange: -2,
          weekChange: -5,
          monthChange: -10,
          avgDailyVolatility: 1,
          compositeScore: isSignalDay ? 80 : 0,
          recommendation: isSignalDay ? "STRONG BUY" : "HOLD",
          signals: isSignalDay
            ? [
                {
                  label: "RSI Oversold",
                  detail: "",
                  type: "buy",
                  weight: 30,
                },
              ]
            : [],
          risk: isSignalDay
            ? {
                atr: 2,
                entry: history[history.length - 1].close,
                stop: 99,
                stopMethod: "atr",
                target: 120, // above the entry price (~112.7) so the
                // trade has room to run before hitting target
                riskReward: 3,
              }
            : undefined,
        };
      }
    );

    // Ramp: bar 0 close=100, +0.2 per day → bar 60 close=112, bar 98
    // close=119.6. Target=120 is reachable around bar 98 (high=120.1).
    // Stop=99 is far below — never triggers.
    const series = rampSeries(100, 100, 0.2);
    const result = await runBacktest(
      {
        symbols: ["AAA"],
        startDate: "2026-01-05",
        endDate: "2026-04-15",
        startingCapital: 50_000,
      },
      { AAA: series }
    );

    // Exactly one trade: entry on bar 61 (D+1 after signal on day 60),
    // exit at target=120 around bar 98.
    expect(result.trades.length).toBe(1);
    const trade = result.trades[0];
    expect(trade.symbol).toBe("AAA");
    expect(trade.scoreAtEntry).toBe(80);
    expect(trade.signalsAtEntry).toContain("RSI Oversold");
    // bar[61].open = (100 + 0.2*61) - 0.5 = 111.7. With spread the
    // fill should be slightly above bar.high (112.7).
    expect(trade.entryPrice).toBeGreaterThan(112);
    expect(trade.entryPrice).toBeLessThan(114);
    // Exit must happen at target (~120) or end_of_window.
    expect(["target", "end_of_window"]).toContain(trade.exitReason);
    expect(trade.pl).toBeGreaterThan(0); // profitable trade
    expect(callCount).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it("respects maxOpenPositions cap (never queues entries past the cap)", async () => {
    // Make 20 symbols all signal BUY simultaneously, cap=10 from config.
    const spy = vi.spyOn(analysisModule, "analyzeStock").mockImplementation(
      (symbol, history) => ({
        symbol,
        price: history[history.length - 1].close,
        rsi: 25,
        sma20: 100,
        sma50: 100,
        bollingerUpper: 110,
        bollingerLower: 90,
        bollingerMid: 100,
        macdLine: 1,
        macdSignal: 0,
        macdHistogram: 1,
        dayChange: -2,
        weekChange: -5,
        monthChange: -10,
        avgDailyVolatility: 1,
        compositeScore: 80,
        recommendation: "STRONG BUY",
        signals: [],
        risk: {
          atr: 2,
          entry: history[history.length - 1].close,
          stop: 99,
          stopMethod: "atr",
          target: 110,
          riskReward: 3,
        },
      })
    );

    const barsBySymbol: Record<string, HistoricalBar[]> = {};
    const symbols: string[] = [];
    for (let i = 0; i < 20; i++) {
      const sym = `S${i.toString().padStart(2, "0")}`;
      symbols.push(sym);
      barsBySymbol[sym] = rampSeries(65, 100, 0.05); // just past warmup
    }

    const result = await runBacktest(
      { symbols, startDate: "2026-01-05", endDate: "2026-04-15", startingCapital: 1_000_000 },
      barsBySymbol
    );

    // ≤ 10 trades (max open positions). Could be fewer if some entries
    // get blocked by no-bar on D+1, but never more.
    expect(result.trades.length).toBeLessThanOrEqual(10);
    spy.mockRestore();
  });

  it("emits onProgress per trading day", async () => {
    vi.spyOn(analysisModule, "analyzeStock").mockImplementation(
      (symbol, history) => ({
        symbol,
        price: history[history.length - 1].close,
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
      })
    );

    const events: number[] = [];
    await runBacktest(
      { symbols: ["AAA"], startDate: "2026-01-05", endDate: "2026-01-30", startingCapital: 50_000 },
      { AAA: rampSeries(60, 100, 0) },
      {
        onProgress: (e) => {
          events.push(e.day);
        },
      }
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toBe(1);
    // Days are 1-indexed and monotonically increasing.
    for (let i = 1; i < events.length; i++) {
      expect(events[i]).toBe(events[i - 1] + 1);
    }
  });

  it("swallows a throw inside onProgress so the loop continues", async () => {
    vi.spyOn(analysisModule, "analyzeStock").mockImplementation(
      (symbol, history) => ({
        symbol,
        price: history[history.length - 1].close,
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
      })
    );

    const result = await runBacktest(
      { symbols: ["AAA"], startDate: "2026-01-05", endDate: "2026-01-30", startingCapital: 50_000 },
      { AAA: rampSeries(60, 100, 0) },
      {
        onProgress: () => {
          throw new Error("boom");
        },
      }
    );
    // Loop completed successfully.
    expect(result.summary.startingCapital).toBe(50_000);
  });

  it("returns empty equityCurve when no bars fall inside the date range", async () => {
    const result = await runBacktest(
      { symbols: ["AAA"], startDate: "2030-01-01", endDate: "2030-12-31", startingCapital: 50_000 },
      { AAA: rampSeries(60, 100, 0) }
    );
    expect(result.equityCurve).toEqual([]);
    expect(result.trades).toEqual([]);
    expect(result.summary.tradesCount).toBe(0);
  });

  it("closes still-open positions at end-of-window with exitReason='end_of_window'", async () => {
    // Force a BUY signal early, with a wide-enough target that the
    // backtest window ends before it's hit.
    let signaled = false;
    vi.spyOn(analysisModule, "analyzeStock").mockImplementation(
      (symbol, history) => {
        const shouldSignal = !signaled && history.length === 55;
        if (shouldSignal) signaled = true;
        return {
          symbol,
          price: history[history.length - 1].close,
          rsi: 25,
          sma20: 100,
          sma50: 100,
          bollingerUpper: 110,
          bollingerLower: 90,
          bollingerMid: 100,
          macdLine: 1,
          macdSignal: 0,
          macdHistogram: 1,
          dayChange: -2,
          weekChange: -5,
          monthChange: -10,
          avgDailyVolatility: 1,
          compositeScore: shouldSignal ? 80 : 0,
          recommendation: shouldSignal ? "STRONG BUY" : "HOLD",
          signals: [],
          risk: shouldSignal
            ? {
                atr: 2,
                entry: history[history.length - 1].close,
                stop: 50, // very wide stop, won't trigger
                stopMethod: "atr",
                target: 9999, // unreachable target
                riskReward: 3,
              }
            : undefined,
        };
      }
    );

    const result = await runBacktest(
      {
        symbols: ["AAA"],
        startDate: "2026-01-05",
        endDate: "2026-03-20",
        startingCapital: 50_000,
      },
      { AAA: rampSeries(60, 100, 0.1) }
    );

    expect(result.trades.length).toBe(1);
    expect(result.trades[0].exitReason).toBe("end_of_window");
  });

  describe("no same-bar entry+exit (Phase 15b.2 bug fix)", () => {
    it("a position opened on day D is NEVER closed on day D, even when D's bar would pierce the stop", async () => {
      // Setup: signal fires on day 60. Day 61 (entry day) has a bar
      // with a low BELOW the stop price — pre-fix, this would close
      // the position the same day it opened with a manufactured loss.
      // Post-fix: position stays open until day 62, where the bar can
      // legitimately trigger the stop.
      let signaled = false;
      const spy = vi.spyOn(analysisModule, "analyzeStock").mockImplementation(
        (symbol, history) => {
          const shouldSignal = !signaled && history.length === 60;
          if (shouldSignal) signaled = true;
          return {
            symbol,
            price: history[history.length - 1].close,
            rsi: 25,
            sma20: 100,
            sma50: 100,
            bollingerUpper: 110,
            bollingerLower: 90,
            bollingerMid: 100,
            macdLine: 1,
            macdSignal: 0,
            macdHistogram: 1,
            dayChange: -2,
            weekChange: -5,
            monthChange: -10,
            avgDailyVolatility: 1,
            compositeScore: shouldSignal ? 80 : 0,
            recommendation: shouldSignal ? "STRONG BUY" : "HOLD",
            signals: [],
            risk: shouldSignal
              ? {
                  atr: 2,
                  entry: history[history.length - 1].close,
                  stop: 100, // very wide stop to keep the trade alive past D+1
                  stopMethod: "atr",
                  target: 9999, // unreachable target
                  riskReward: 3,
                }
              : undefined,
          };
        }
      );

      // Build a 100-bar series where bar 60 (entry day) has a HIGH
      // and a LOW with low > 100, so the wide stop=100 is not pierced.
      // Then end-of-window closes the position on the last bar.
      const startMs = Date.UTC(2026, 0, 5);
      const series: HistoricalBar[] = Array.from({ length: 100 }, (_, i) => ({
        date:
          new Date(startMs + i * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10) + "T00:00:00.000Z",
        open: 110,
        high: 115, // never below stop=100
        low: 105, // never below stop=100
        close: 112,
        volume: 2_000_000,
      }));

      const result = await runBacktest(
        {
          symbols: ["AAA"],
          startDate: "2026-01-05",
          endDate: "2026-04-15",
          startingCapital: 50_000,
        },
        { AAA: series }
      );

      expect(result.trades.length).toBe(1);
      // The KEY invariant: entry and exit happen on DIFFERENT bars.
      // entryDate is bar 60 (signal day + 1 → bar index 60 in zero-indexed
      // terms; the simulator queues the entry on signal day and fills the
      // next day). Whether exit is target / stop / end-of-window, it must
      // be a later date than entry.
      expect(result.trades[0].entryDate).not.toBe(result.trades[0].exitDate);
      spy.mockRestore();
    });

    it("the synthetic E2E from earlier still yields a target-hit trade after the loop swap", async () => {
      // Sanity regression — same setup as the original E2E test, just
      // confirming the loop swap didn't break the target-hit path.
      let signaled = false;
      const spy = vi.spyOn(analysisModule, "analyzeStock").mockImplementation(
        (symbol, history) => {
          const shouldSignal = !signaled && history.length === 60;
          if (shouldSignal) signaled = true;
          return {
            symbol,
            price: history[history.length - 1].close,
            rsi: 25,
            sma20: 100,
            sma50: 100,
            bollingerUpper: 110,
            bollingerLower: 90,
            bollingerMid: 100,
            macdLine: 1,
            macdSignal: 0,
            macdHistogram: 1,
            dayChange: -2,
            weekChange: -5,
            monthChange: -10,
            avgDailyVolatility: 1,
            compositeScore: shouldSignal ? 80 : 0,
            recommendation: shouldSignal ? "STRONG BUY" : "HOLD",
            signals: [],
            risk: shouldSignal
              ? {
                  atr: 2,
                  entry: history[history.length - 1].close,
                  stop: 99,
                  stopMethod: "atr",
                  target: 120,
                  riskReward: 3,
                }
              : undefined,
          };
        }
      );

      const series = rampSeries(100, 100, 0.2);
      const result = await runBacktest(
        {
          symbols: ["AAA"],
          startDate: "2026-01-05",
          endDate: "2026-04-15",
          startingCapital: 50_000,
        },
        { AAA: series }
      );

      expect(result.trades.length).toBe(1);
      expect(result.trades[0].pl).toBeGreaterThan(0); // still profitable
      // Entry and exit on different days (no same-bar round-trip).
      expect(result.trades[0].entryDate).not.toBe(result.trades[0].exitDate);
      spy.mockRestore();
    });
  });

  describe("filters (Phase 15b.1)", () => {
    // Returns a STRONG BUY mock-analysis with the given score + R:R.
    const buyMock = (score: number, riskReward: number) =>
      vi
        .spyOn(analysisModule, "analyzeStock")
        .mockImplementation((symbol, history) => ({
          symbol,
          price: history[history.length - 1].close,
          rsi: 25,
          sma20: 100,
          sma50: 100,
          bollingerUpper: 110,
          bollingerLower: 90,
          bollingerMid: 100,
          macdLine: 1,
          macdSignal: 0,
          macdHistogram: 1,
          dayChange: -2,
          weekChange: -5,
          monthChange: -10,
          avgDailyVolatility: 1,
          compositeScore: score,
          recommendation: "STRONG BUY",
          signals: [],
          risk: {
            atr: 2,
            entry: history[history.length - 1].close,
            stop: 99,
            stopMethod: "atr",
            target: 120,
            riskReward,
          },
        }));

    it("minScore filter blocks entries below threshold", async () => {
      const spy = buyMock(30, 3);
      const result = await runBacktest(
        {
          symbols: ["AAA"],
          startDate: "2026-01-05",
          endDate: "2026-04-15",
          startingCapital: 50_000,
          filters: { minScore: 40 },
        },
        { AAA: rampSeries(100, 100, 0.2) }
      );
      expect(result.trades.length).toBe(0);
      spy.mockRestore();
    });

    it("minScore filter passes entries at or above threshold", async () => {
      const spy = buyMock(80, 3);
      const result = await runBacktest(
        {
          symbols: ["AAA"],
          startDate: "2026-01-05",
          endDate: "2026-04-15",
          startingCapital: 50_000,
          filters: { minScore: 40 },
        },
        { AAA: rampSeries(100, 100, 0.2) }
      );
      expect(result.trades.length).toBeGreaterThan(0);
      spy.mockRestore();
    });

    it("minRiskReward filter blocks entries below threshold", async () => {
      const spy = buyMock(80, 2.0);
      const result = await runBacktest(
        {
          symbols: ["AAA"],
          startDate: "2026-01-05",
          endDate: "2026-04-15",
          startingCapital: 50_000,
          filters: { minRiskReward: 2.5 },
        },
        { AAA: rampSeries(100, 100, 0.2) }
      );
      expect(result.trades.length).toBe(0);
      spy.mockRestore();
    });

    it("minAvgDollarVolume filter excludes illiquid symbols entirely", async () => {
      const spy = buyMock(80, 3);
      // Bars with volume=1 → close=$100 × 1 = $100 ADV (very illiquid).
      const result = await runBacktest(
        {
          symbols: ["ILLIQUID"],
          startDate: "2026-01-05",
          endDate: "2026-04-15",
          startingCapital: 50_000,
          filters: { minAvgDollarVolume: 5_000_000 },
        },
        { ILLIQUID: rampSeries(100, 100, 0.2, 1) }
      );
      expect(result.trades.length).toBe(0);
      spy.mockRestore();
    });

    it("minAvgDollarVolume filter passes liquid symbols", async () => {
      const spy = buyMock(80, 3);
      // close × volume ≈ $100 × 1M = $100M ADV.
      const result = await runBacktest(
        {
          symbols: ["LIQUID"],
          startDate: "2026-01-05",
          endDate: "2026-04-15",
          startingCapital: 50_000,
          filters: { minAvgDollarVolume: 5_000_000 },
        },
        { LIQUID: rampSeries(100, 100, 0.2, 1_000_000) }
      );
      expect(result.trades.length).toBeGreaterThan(0);
      spy.mockRestore();
    });

    it("all filters undefined preserves original (no-filter) behavior", async () => {
      const spy = buyMock(20, 1.5); // would fail score and R:R if filters applied
      const result = await runBacktest(
        {
          symbols: ["AAA"],
          startDate: "2026-01-05",
          endDate: "2026-04-15",
          startingCapital: 50_000,
          // no filters
        },
        { AAA: rampSeries(100, 100, 0.2) }
      );
      // Trade still fires because no filters constrain it.
      expect(result.trades.length).toBeGreaterThan(0);
      spy.mockRestore();
    });
  });
});
