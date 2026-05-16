import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const yfMock: any = { options: vi.fn() };
vi.mock("yahoo-finance2", () => ({
  default: function () {
    return yfMock;
  },
}));

const dbMock: any = {
  watchlistStock: { findMany: vi.fn() },
  optionsSnapshot: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
};
vi.mock("@/lib/db", () => ({ db: dbMock }));

const loggerMock: any = {
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
};
vi.mock("@/lib/logger", () => loggerMock);

function mkChain(overrides: Partial<{
  underlying: number;
  calls: Array<{ strike: number; iv: number; volume?: number; oi?: number }>;
  puts: Array<{ strike: number; iv: number; volume?: number; oi?: number }>;
}> = {}) {
  const underlying = overrides.underlying ?? 100;
  const calls = overrides.calls ?? [
    { strike: 100, iv: 0.30, volume: 200, oi: 1000 },
    { strike: 105, iv: 0.32, volume: 50, oi: 400 },
  ];
  const puts = overrides.puts ?? [
    { strike: 100, iv: 0.34, volume: 150, oi: 500 },
    { strike: 95, iv: 0.36, volume: 80, oi: 300 },
  ];
  return {
    underlyingSymbol: "TEST",
    expirationDates: [new Date()],
    strikes: calls.map((c) => c.strike),
    hasMiniOptions: false,
    quote: { regularMarketPrice: underlying },
    options: [
      {
        expirationDate: new Date(),
        hasMiniOptions: false,
        calls: calls.map((c) => ({
          strike: c.strike,
          impliedVolatility: c.iv,
          volume: c.volume ?? 0,
          openInterest: c.oi ?? 0,
          contractSymbol: `C${c.strike}`,
          contractSize: "REGULAR" as const,
          expiration: new Date(),
          lastTradeDate: new Date(),
          lastPrice: 1,
          change: 0,
          inTheMoney: false,
        })),
        puts: puts.map((p) => ({
          strike: p.strike,
          impliedVolatility: p.iv,
          volume: p.volume ?? 0,
          openInterest: p.oi ?? 0,
          contractSymbol: `P${p.strike}`,
          contractSize: "REGULAR" as const,
          expiration: new Date(),
          lastTradeDate: new Date(),
          lastPrice: 1,
          change: 0,
          inTheMoney: false,
        })),
      },
    ],
  };
}

beforeEach(() => {
  vi.resetModules();
  yfMock.options = vi.fn();
  dbMock.watchlistStock.findMany = vi.fn().mockResolvedValue([]);
  dbMock.optionsSnapshot.create = vi.fn().mockResolvedValue({});
  dbMock.optionsSnapshot.findMany = vi.fn().mockResolvedValue([]);
  dbMock.optionsSnapshot.findFirst = vi.fn().mockResolvedValue(null);
  loggerMock.log.info = vi.fn();
  loggerMock.log.warn = vi.fn();
  loggerMock.log.error = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("refreshOptionsForSymbol", () => {
  it("returns null and skips persist when yahoo throws (no options chain)", async () => {
    yfMock.options.mockRejectedValue(new Error("no chain"));
    const mod = await import("@/lib/options-source");
    const r = await mod.refreshOptionsForSymbol("XYZ");
    expect(r).toBeNull();
    expect(dbMock.optionsSnapshot.create).not.toHaveBeenCalled();
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "options",
      "fetch.no-chain",
      expect.any(Object)
    );
  });

  it("returns null when the chain has zero expirations", async () => {
    yfMock.options.mockResolvedValue({
      underlyingSymbol: "X",
      expirationDates: [],
      strikes: [],
      hasMiniOptions: false,
      quote: { regularMarketPrice: 100 },
      options: [],
    });
    const mod = await import("@/lib/options-source");
    const r = await mod.refreshOptionsForSymbol("X");
    expect(r).toBeNull();
    expect(dbMock.optionsSnapshot.create).not.toHaveBeenCalled();
  });

  it("returns null when the underlying price is missing or invalid", async () => {
    yfMock.options.mockResolvedValue({
      underlyingSymbol: "X",
      expirationDates: [new Date()],
      strikes: [100],
      hasMiniOptions: false,
      quote: { regularMarketPrice: 0 },
      options: [{ expirationDate: new Date(), hasMiniOptions: false, calls: [], puts: [] }],
    });
    const mod = await import("@/lib/options-source");
    expect(await mod.refreshOptionsForSymbol("X")).toBeNull();
  });

  it("persists an OptionsSnapshot on a happy chain", async () => {
    yfMock.options.mockResolvedValue(mkChain());
    const mod = await import("@/lib/options-source");
    const a = await mod.refreshOptionsForSymbol("AAPL");
    expect(a).not.toBeNull();
    expect(dbMock.optionsSnapshot.create).toHaveBeenCalledTimes(1);
    const persisted = dbMock.optionsSnapshot.create.mock.calls[0][0].data;
    expect(persisted.symbol).toBe("AAPL");
    expect(persisted.atmIV).toBeCloseTo(0.30, 5);
    expect(persisted.callVolume).toBe(250);
    expect(persisted.putVolume).toBe(230);
  });

  it("logs a warn but still returns the activity when persist fails", async () => {
    yfMock.options.mockResolvedValue(mkChain());
    dbMock.optionsSnapshot.create.mockRejectedValueOnce(new Error("db down"));
    const mod = await import("@/lib/options-source");
    const a = await mod.refreshOptionsForSymbol("AAPL");
    expect(a).not.toBeNull();
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "options",
      "persist.failure",
      expect.any(Object)
    );
  });
});

describe("refreshAllOptions", () => {
  it("iterates the watchlist, tallying succeeded vs skipped vs errored", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAPL", name: "Apple", sector: "Tech" },
      { symbol: "NOOPT", name: "Microcap", sector: "Other" },
      { symbol: "FAIL", name: "Failer", sector: "Other" },
    ]);
    yfMock.options.mockImplementation(async (s: string) => {
      if (s === "AAPL") return mkChain();
      if (s === "NOOPT") throw new Error("no chain");
      throw new Error("transient");
    });
    // Skip the 1.1s delays in the test loop.
    vi.useFakeTimers();
    const mod = await import("@/lib/options-source");
    const promise = mod.refreshAllOptions();
    await vi.runAllTimersAsync();
    const r = await promise;
    vi.useRealTimers();
    // 1 happy, 2 yahoo-failure → skipped (refreshOptionsForSymbol returns
    // null on yahoo throw, not errored).
    expect(r.total).toBe(3);
    expect(r.succeeded).toBe(1);
    expect(r.skipped + r.errored).toBe(2);
  });

  it("emits progress logs at the configured cadence", async () => {
    const watchlist = Array.from({ length: 51 }, (_, i) => ({
      symbol: `S${i}`,
      name: `S${i}`,
      sector: "Other",
    }));
    dbMock.watchlistStock.findMany.mockResolvedValue(watchlist);
    yfMock.options.mockResolvedValue(mkChain());
    vi.useFakeTimers();
    const mod = await import("@/lib/options-source");
    const promise = mod.refreshAllOptions();
    await vi.runAllTimersAsync();
    await promise;
    vi.useRealTimers();
    // At progressLogEveryN=50, one progress event should land after #50.
    const progressLogs = loggerMock.log.info.mock.calls.filter(
      (c: [string, string]) => c[1] === "refresh.progress"
    );
    expect(progressLogs.length).toBeGreaterThanOrEqual(1);
  });
});

describe("getHistoricalIVForSymbol", () => {
  it("returns the trailing IV series as a plain number[]", async () => {
    dbMock.optionsSnapshot.findMany.mockResolvedValue([
      { atmIV: 0.2 },
      { atmIV: 0.25 },
      { atmIV: 0.3 },
    ]);
    const mod = await import("@/lib/options-source");
    const series = await mod.getHistoricalIVForSymbol("AAPL");
    expect(series).toEqual([0.2, 0.25, 0.3]);
  });
});

describe("getLatestOptionsForSymbol", () => {
  it("returns null when no snapshot has been persisted", async () => {
    dbMock.optionsSnapshot.findFirst.mockResolvedValue(null);
    const mod = await import("@/lib/options-source");
    expect(await mod.getLatestOptionsForSymbol("AAPL")).toBeNull();
  });

  it("recomputes ivRank from fresh history (not from the persisted row's day)", async () => {
    dbMock.optionsSnapshot.findFirst.mockResolvedValue({
      symbol: "AAPL",
      atmIV: 0.45,
      putCallRatio: 1.1,
      skew: 0.03,
      unusualCalls: false,
      unusualPuts: false,
      callVolume: 1000,
      putVolume: 1100,
      callOpenInterest: 2000,
      putOpenInterest: 1800,
      fetchedAt: new Date(),
    });
    // 80 historical snapshots all at 0.2 — today's 0.45 is at the top.
    dbMock.optionsSnapshot.findMany.mockResolvedValue(
      Array.from({ length: 80 }, () => ({ atmIV: 0.2 }))
    );
    const mod = await import("@/lib/options-source");
    const a = await mod.getLatestOptionsForSymbol("AAPL");
    expect(a?.ivRank).toBe(100);
    // High rank fires the bearish boost.
    expect(a?.scoreAdjustment).toBeLessThan(0);
  });

  it("yields scoreAdjustment 0 when history is too short for rank", async () => {
    dbMock.optionsSnapshot.findFirst.mockResolvedValue({
      symbol: "AAPL",
      atmIV: 0.45,
      putCallRatio: 1,
      skew: 0,
      unusualCalls: false,
      unusualPuts: false,
      callVolume: 0,
      putVolume: 0,
      callOpenInterest: 0,
      putOpenInterest: 0,
      fetchedAt: new Date(),
    });
    dbMock.optionsSnapshot.findMany.mockResolvedValue([{ atmIV: 0.2 }]);
    const mod = await import("@/lib/options-source");
    const a = await mod.getLatestOptionsForSymbol("AAPL");
    expect(a?.ivRank).toBeNull();
    expect(a?.scoreAdjustment).toBe(0);
  });
});
