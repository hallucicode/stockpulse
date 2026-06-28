import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbMock, loggerMock, yahooChartMock, throttleMock } = vi.hoisted(() => ({
  dbMock: {
    historicalBar: {
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
    watchlistStock: {
      findMany: vi.fn(),
    },
  },
  loggerMock: {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
  yahooChartMock: vi.fn(),
  throttleMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/logger", () => loggerMock);
vi.mock("yahoo-finance2", () => {
  return {
    default: class FakeYahoo {
      chart = yahooChartMock;
    },
  };
});
vi.mock("@/lib/throttle", () => ({
  serialThrottle: throttleMock,
}));

import {
  backfillSymbol,
  backfillWatchlist,
  countLargeGaps,
  listSymbolSummaries,
  getSymbolBars,
} from "@/lib/historical-bars-source";

function bar(dateIso: string, overrides: Partial<Record<string, number | null>> = {}) {
  return {
    date: new Date(dateIso),
    open: 100,
    high: 105,
    low: 95,
    close: 102,
    volume: 1_000_000,
    adjclose: 102,
    ...overrides,
  };
}

beforeEach(() => {
  dbMock.historicalBar.upsert = vi.fn().mockResolvedValue({});
  dbMock.historicalBar.findMany = vi.fn().mockResolvedValue([]);
  dbMock.watchlistStock.findMany = vi.fn().mockResolvedValue([]);
  loggerMock.log.info = vi.fn();
  loggerMock.log.warn = vi.fn();
  yahooChartMock.mockReset();
  throttleMock.mockReset();
});

describe("backfillSymbol", () => {
  it("upserts every usable bar and reports the count", async () => {
    yahooChartMock.mockResolvedValue({
      quotes: [
        bar("2026-01-05T00:00:00Z"),
        bar("2026-01-06T00:00:00Z"),
        bar("2026-01-07T00:00:00Z"),
      ],
    });
    const result = await backfillSymbol("AAPL", 1);
    expect(result).toEqual({ symbol: "AAPL", barsWritten: 3, empty: false });
    expect(dbMock.historicalBar.upsert).toHaveBeenCalledTimes(3);
    expect(yahooChartMock).toHaveBeenCalledWith(
      "AAPL",
      expect.objectContaining({ interval: "1d" })
    );
  });

  it("is idempotent — the upsert call shape matches `where: symbol_date`", async () => {
    yahooChartMock.mockResolvedValue({
      quotes: [bar("2026-01-05T00:00:00Z")],
    });
    await backfillSymbol("AAPL", 1);
    const call = dbMock.historicalBar.upsert.mock.calls[0][0];
    expect(call.where.symbol_date.symbol).toBe("AAPL");
    expect(call.where.symbol_date.date).toBeInstanceOf(Date);
    expect(call.create.open).toBe(100);
    expect(call.update.open).toBe(100);
  });

  it("returns empty=true when Yahoo serves no quotes", async () => {
    yahooChartMock.mockResolvedValue({ quotes: [] });
    const result = await backfillSymbol("DELISTED", 1);
    expect(result).toEqual({ symbol: "DELISTED", barsWritten: 0, empty: true });
    expect(dbMock.historicalBar.upsert).not.toHaveBeenCalled();
    expect(loggerMock.log.info).toHaveBeenCalledWith(
      "historical",
      "fetch.empty",
      { symbol: "DELISTED" }
    );
  });

  it("handles undefined quotes array", async () => {
    yahooChartMock.mockResolvedValue({});
    const result = await backfillSymbol("X", 1);
    expect(result.empty).toBe(true);
  });

  it("filters out bars with null OHLCV fields (halted sessions)", async () => {
    yahooChartMock.mockResolvedValue({
      quotes: [
        bar("2026-01-05T00:00:00Z"),
        bar("2026-01-06T00:00:00Z", { close: null }), // dropped
        bar("2026-01-07T00:00:00Z", { volume: null }), // dropped
        bar("2026-01-08T00:00:00Z"),
      ],
    });
    const result = await backfillSymbol("AAPL", 1);
    expect(result.barsWritten).toBe(2);
    expect(dbMock.historicalBar.upsert).toHaveBeenCalledTimes(2);
  });

  it("filters out bars with invalid dates", async () => {
    yahooChartMock.mockResolvedValue({
      quotes: [
        { ...bar("2026-01-05T00:00:00Z") },
        { ...bar("2026-01-06T00:00:00Z"), date: new Date("invalid") },
      ],
    });
    const result = await backfillSymbol("AAPL", 1);
    expect(result.barsWritten).toBe(1);
  });

  it("returns error when Yahoo throws", async () => {
    yahooChartMock.mockRejectedValue(new Error("network blew up"));
    const result = await backfillSymbol("AAPL", 1);
    expect(result.error).toBe("network blew up");
    expect(result.barsWritten).toBe(0);
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "historical",
      "fetch.failure",
      expect.objectContaining({ symbol: "AAPL" })
    );
  });

  it("returns error when Yahoo throws a non-Error value", async () => {
    yahooChartMock.mockRejectedValue("string error");
    const result = await backfillSymbol("AAPL", 1);
    expect(result.error).toBe("string error");
  });

  it("returns partial count + error when upsert fails mid-chunk", async () => {
    yahooChartMock.mockResolvedValue({
      quotes: [bar("2026-01-05T00:00:00Z"), bar("2026-01-06T00:00:00Z")],
    });
    dbMock.historicalBar.upsert = vi
      .fn()
      .mockRejectedValue(new Error("disk full"));
    const result = await backfillSymbol("AAPL", 1);
    expect(result.error).toBe("disk full");
    expect(result.barsWritten).toBe(0);
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "historical",
      "persist.failure",
      expect.objectContaining({ symbol: "AAPL" })
    );
  });

  it("nulls non-numeric adjClose values rather than persisting NaN", async () => {
    yahooChartMock.mockResolvedValue({
      quotes: [
        {
          date: new Date("2026-01-05T00:00:00Z"),
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 1000,
          adjclose: "garbage",
        },
      ],
    });
    await backfillSymbol("AAPL", 1);
    const call = dbMock.historicalBar.upsert.mock.calls[0][0];
    expect(call.create.adjClose).toBeNull();
  });
});

describe("backfillWatchlist", () => {
  it("walks every watchlist symbol via the throttle and aggregates results", async () => {
    dbMock.watchlistStock.findMany = vi.fn().mockResolvedValue([
      { symbol: "AAA" },
      { symbol: "BBB" },
      { symbol: "CCC" },
    ]);
    yahooChartMock
      .mockResolvedValueOnce({ quotes: [bar("2026-01-05T00:00:00Z")] })
      .mockResolvedValueOnce({ quotes: [] })
      .mockRejectedValueOnce(new Error("nope"));

    throttleMock.mockImplementation(async (opts) => {
      for (let i = 0; i < opts.items.length; i++) {
        await opts.run(opts.items[i], i);
      }
      return {
        total: opts.items.length,
        succeeded: 0,
        skipped: 0,
        rateLimited: 0,
        errored: 0,
      };
    });

    const summary = await backfillWatchlist(1);

    expect(summary).toEqual({
      totalSymbols: 3,
      succeeded: 1,
      empty: 1,
      errored: 1,
      totalBarsWritten: 1,
    });
    expect(loggerMock.log.info).toHaveBeenCalledWith(
      "historical",
      "backfill.start",
      expect.objectContaining({ symbolCount: 3, years: 1 })
    );
    expect(loggerMock.log.info).toHaveBeenCalledWith(
      "historical",
      "backfill.done",
      expect.objectContaining({ succeeded: 1, empty: 1, errored: 1 })
    );
  });

  it("fires onSymbol for each symbol with correct event shape", async () => {
    dbMock.watchlistStock.findMany = vi
      .fn()
      .mockResolvedValue([{ symbol: "AAA" }, { symbol: "BBB" }]);
    yahooChartMock
      .mockResolvedValueOnce({ quotes: [bar("2026-01-05T00:00:00Z")] })
      .mockResolvedValueOnce({ quotes: [] });
    throttleMock.mockImplementation(async (opts) => {
      for (let i = 0; i < opts.items.length; i++) {
        await opts.run(opts.items[i], i);
      }
      return {
        total: opts.items.length,
        succeeded: 0,
        skipped: 0,
        rateLimited: 0,
        errored: 0,
      };
    });

    const events: unknown[] = [];
    await backfillWatchlist(1, {
      onSymbol: (e) => {
        events.push(e);
      },
    });
    expect(events).toEqual([
      {
        symbol: "AAA",
        processed: 1,
        total: 2,
        barsWrittenThisSymbol: 1,
        status: "ok",
      },
      {
        symbol: "BBB",
        processed: 2,
        total: 2,
        barsWrittenThisSymbol: 0,
        status: "empty",
      },
    ]);
  });

  it("fires onSymbol with status=error when the symbol fetch fails", async () => {
    dbMock.watchlistStock.findMany = vi
      .fn()
      .mockResolvedValue([{ symbol: "FAIL" }]);
    yahooChartMock.mockRejectedValue(new Error("nope"));
    throttleMock.mockImplementation(async (opts) => {
      for (let i = 0; i < opts.items.length; i++) {
        await opts.run(opts.items[i], i);
      }
      return {
        total: 1,
        succeeded: 0,
        skipped: 0,
        rateLimited: 0,
        errored: 0,
      };
    });
    const events: unknown[] = [];
    await backfillWatchlist(1, {
      onSymbol: (e) => {
        events.push(e);
      },
    });
    expect((events[0] as { status: string }).status).toBe("error");
  });

  it("swallows a throw inside onSymbol so the loop keeps running", async () => {
    dbMock.watchlistStock.findMany = vi
      .fn()
      .mockResolvedValue([{ symbol: "AAA" }, { symbol: "BBB" }]);
    yahooChartMock.mockResolvedValue({ quotes: [bar("2026-01-05T00:00:00Z")] });
    throttleMock.mockImplementation(async (opts) => {
      for (let i = 0; i < opts.items.length; i++) {
        await opts.run(opts.items[i], i);
      }
      return {
        total: 2,
        succeeded: 2,
        skipped: 0,
        rateLimited: 0,
        errored: 0,
      };
    });
    let invocations = 0;
    await backfillWatchlist(1, {
      onSymbol: () => {
        invocations += 1;
        throw new Error("callback boom");
      },
    });
    // Both symbols processed despite the callback throwing.
    expect(invocations).toBe(2);
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "historical",
      "onSymbol.callback.failure",
      expect.any(Object)
    );
  });

  it("handles an empty watchlist gracefully", async () => {
    dbMock.watchlistStock.findMany = vi.fn().mockResolvedValue([]);
    throttleMock.mockImplementation(async () => ({
      total: 0,
      succeeded: 0,
      skipped: 0,
      rateLimited: 0,
      errored: 0,
    }));
    const summary = await backfillWatchlist(1);
    expect(summary.totalSymbols).toBe(0);
    expect(summary.totalBarsWritten).toBe(0);
  });
});

describe("countLargeGaps", () => {
  it("returns 0 for fewer than 2 dates", () => {
    expect(countLargeGaps([])).toBe(0);
    expect(countLargeGaps([new Date("2026-01-05")])).toBe(0);
  });

  it("counts no gaps for daily series (excluding weekend skip)", () => {
    // Mon-Tue-Wed-Thu-Fri: 1-day gaps everywhere.
    const dates = [
      new Date("2026-01-05"),
      new Date("2026-01-06"),
      new Date("2026-01-07"),
      new Date("2026-01-08"),
      new Date("2026-01-09"),
    ];
    expect(countLargeGaps(dates)).toBe(0);
  });

  it("tolerates a normal Fri→Mon weekend (3-day gap)", () => {
    const dates = [
      new Date("2026-01-09"), // Fri
      new Date("2026-01-12"), // Mon
    ];
    expect(countLargeGaps(dates)).toBe(0);
  });

  it("flags a > 4-day gap as one missed window", () => {
    const dates = [
      new Date("2026-01-05"),
      new Date("2026-01-15"), // 10-day jump
    ];
    expect(countLargeGaps(dates)).toBe(1);
  });

  it("sorts input before walking — unsorted input still works", () => {
    const dates = [
      new Date("2026-01-15"),
      new Date("2026-01-05"),
      new Date("2026-01-06"),
    ];
    // Sorted: Jan 5 → Jan 6 (1d) → Jan 15 (9d). One gap.
    expect(countLargeGaps(dates)).toBe(1);
  });
});

describe("listSymbolSummaries", () => {
  it("returns a row per watchlist symbol with bar counts and gap detection", async () => {
    dbMock.watchlistStock.findMany = vi
      .fn()
      .mockResolvedValue([{ symbol: "AAA" }, { symbol: "BBB" }]);
    dbMock.historicalBar.findMany = vi.fn().mockImplementation((q) => {
      if (q.where.symbol === "AAA") {
        return Promise.resolve([
          { date: new Date("2026-01-05") },
          { date: new Date("2026-01-06") },
          { date: new Date("2026-01-20") }, // big gap from Jan 6
        ]);
      }
      return Promise.resolve([]);
    });

    const summaries = await listSymbolSummaries();
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toEqual({
      symbol: "AAA",
      barCount: 3,
      firstDate: new Date("2026-01-05").toISOString(),
      lastDate: new Date("2026-01-20").toISOString(),
      gapCount: 1,
    });
    expect(summaries[1]).toEqual({
      symbol: "BBB",
      barCount: 0,
      firstDate: null,
      lastDate: null,
      gapCount: 0,
    });
  });
});

describe("getSymbolBars", () => {
  it("returns ISO-date-stringified rows in date-ascending order", async () => {
    dbMock.historicalBar.findMany = vi.fn().mockResolvedValue([
      {
        date: new Date("2026-01-05T00:00:00Z"),
        open: 100,
        high: 105,
        low: 95,
        close: 102,
        volume: 1_000_000,
      },
      {
        date: new Date("2026-01-06T00:00:00Z"),
        open: 102,
        high: 108,
        low: 101,
        close: 107,
        volume: 1_200_000,
      },
    ]);

    const result = await getSymbolBars("AAPL");
    expect(result).toEqual([
      {
        date: "2026-01-05T00:00:00.000Z",
        open: 100,
        high: 105,
        low: 95,
        close: 102,
        volume: 1_000_000,
      },
      {
        date: "2026-01-06T00:00:00.000Z",
        open: 102,
        high: 108,
        low: 101,
        close: 107,
        volume: 1_200_000,
      },
    ]);
    expect(dbMock.historicalBar.findMany).toHaveBeenCalledWith({
      where: { symbol: "AAPL" },
      orderBy: { date: "asc" },
    });
  });

  it("returns an empty array when the symbol has no bars", async () => {
    dbMock.historicalBar.findMany = vi.fn().mockResolvedValue([]);
    expect(await getSymbolBars("UNKNOWN")).toEqual([]);
  });
});
