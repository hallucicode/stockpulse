import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock, loggerMock, runBacktestMock } = vi.hoisted(() => ({
  dbMock: {
    historicalBar: { findMany: vi.fn() },
    watchlistStock: { findMany: vi.fn() },
    backtestRun: { create: vi.fn(), findMany: vi.fn() },
  },
  loggerMock: {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
  runBacktestMock: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/logger", () => loggerMock);
vi.mock("@/lib/backtest", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backtest")>(
    "@/lib/backtest"
  );
  return { ...actual, runBacktest: runBacktestMock };
});

import {
  loadBarsForSymbols,
  runAndPersistBacktest,
  listBacktestRuns,
} from "@/lib/backtest-source";

const FAKE_RESULT = {
  params: {
    symbols: ["AAA"],
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    startingCapital: 50_000,
  },
  trades: [],
  equityCurve: [],
  summary: {
    symbolsConsidered: 1,
    symbolsWithEnoughHistory: 1,
    tradesCount: 0,
    winningTrades: 0,
    losingTrades: 0,
    startingCapital: 50_000,
    endingCapital: 50_000,
    totalReturn: 0,
    totalReturnPct: 0,
    cashRemaining: 50_000,
  },
};

beforeEach(() => {
  dbMock.historicalBar.findMany = vi.fn().mockResolvedValue([]);
  dbMock.watchlistStock.findMany = vi.fn().mockResolvedValue([]);
  dbMock.backtestRun.create = vi.fn().mockResolvedValue({ id: "run-1" });
  dbMock.backtestRun.findMany = vi.fn().mockResolvedValue([]);
  runBacktestMock.mockReset();
  runBacktestMock.mockResolvedValue(FAKE_RESULT);
  loggerMock.log.info = vi.fn();
  loggerMock.log.warn = vi.fn();
  loggerMock.log.error = vi.fn();
});

describe("loadBarsForSymbols", () => {
  it("maps Prisma rows into HistoricalBar shape with ISO dates", async () => {
    dbMock.historicalBar.findMany = vi.fn().mockResolvedValue([
      {
        date: new Date("2026-01-05T00:00:00Z"),
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 1_000_000,
      },
    ]);
    const out = await loadBarsForSymbols(["AAA"]);
    expect(out.AAA).toEqual([
      {
        date: "2026-01-05T00:00:00.000Z",
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 1_000_000,
      },
    ]);
  });

  it("includes symbols with zero bars (mapped to [])", async () => {
    dbMock.historicalBar.findMany = vi.fn().mockResolvedValue([]);
    const out = await loadBarsForSymbols(["ZZZ"]);
    expect(out.ZZZ).toEqual([]);
  });
});

describe("runAndPersistBacktest", () => {
  it("uses the entire watchlist when symbols are omitted", async () => {
    dbMock.watchlistStock.findMany = vi
      .fn()
      .mockResolvedValue([{ symbol: "AAA" }, { symbol: "BBB" }]);
    await runAndPersistBacktest({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      startingCapital: 50_000,
    });
    expect(dbMock.watchlistStock.findMany).toHaveBeenCalled();
    const arg = runBacktestMock.mock.calls[0][0];
    expect(arg.symbols).toEqual(["AAA", "BBB"]);
  });

  it("uses provided symbols and skips the watchlist read", async () => {
    await runAndPersistBacktest({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      startingCapital: 50_000,
      symbols: ["NVDA", "MSFT"],
    });
    expect(dbMock.watchlistStock.findMany).not.toHaveBeenCalled();
    const arg = runBacktestMock.mock.calls[0][0];
    expect(arg.symbols).toEqual(["NVDA", "MSFT"]);
  });

  it("persists a BacktestRun row + returns the in-memory result", async () => {
    const { runId, result } = await runAndPersistBacktest({
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      startingCapital: 50_000,
      symbols: ["AAA"],
    });
    expect(runId).toBe("run-1");
    expect(result).toBe(FAKE_RESULT);
    expect(dbMock.backtestRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paramsJson: expect.any(String),
          resultJson: expect.any(String),
        }),
      })
    );
  });

  it("forwards onProgress to the underlying runBacktest", async () => {
    const cb = vi.fn();
    await runAndPersistBacktest(
      {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        startingCapital: 50_000,
        symbols: ["AAA"],
      },
      { onProgress: cb }
    );
    const opts = runBacktestMock.mock.calls[0][2];
    expect(opts.onProgress).toBe(cb);
  });
});

describe("listBacktestRuns", () => {
  it("returns runs newest-first with summary fields lifted from JSON", async () => {
    dbMock.backtestRun.findMany = vi.fn().mockResolvedValue([
      {
        id: "r1",
        startedAt: new Date("2026-01-15T10:00:00Z"),
        completedAt: new Date("2026-01-15T10:05:00Z"),
        paramsJson: JSON.stringify({
          symbols: ["AAA", "BBB"],
          startDate: "2025-01-01",
          endDate: "2026-01-01",
          startingCapital: 100_000,
        }),
        resultJson: JSON.stringify({
          summary: { totalReturnPct: 12.5, tradesCount: 42 },
        }),
      },
    ]);
    const runs = await listBacktestRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: "r1",
      totalReturnPct: 12.5,
      tradesCount: 42,
      startDate: "2025-01-01",
      endDate: "2026-01-01",
      startingCapital: 100_000,
      symbolCount: 2,
    });
  });

  it("tolerates malformed paramsJson / resultJson by logging + zero defaults", async () => {
    dbMock.backtestRun.findMany = vi.fn().mockResolvedValue([
      {
        id: "broken",
        startedAt: new Date("2026-01-15T10:00:00Z"),
        completedAt: new Date("2026-01-15T10:05:00Z"),
        paramsJson: "{not json",
        resultJson: "{also not",
      },
    ]);
    const runs = await listBacktestRuns();
    expect(runs[0]).toMatchObject({
      id: "broken",
      totalReturnPct: 0,
      tradesCount: 0,
      symbolCount: 0,
    });
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "backtest",
      "list.params.parse.failure",
      expect.any(Object)
    );
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "backtest",
      "list.result.parse.failure",
      expect.any(Object)
    );
  });
});
