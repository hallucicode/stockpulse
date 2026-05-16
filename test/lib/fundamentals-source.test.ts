import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", async () => {
  const real: any = await vi.importActual("@/lib/config");
  return {
    ...real,
    FUNDAMENTALS_CONFIG: {
      ...real.FUNDAMENTALS_CONFIG,
      requestSpacingMs: 0,
      rateLimitBackoffMs: 0,
    },
  };
});

const dbMock: any = {
  watchlistStock: { findMany: vi.fn() },
  fundamentalsSnapshot: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
  },
};
vi.mock("@/lib/db", () => ({ db: dbMock }));

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  dbMock.watchlistStock.findMany = vi.fn().mockResolvedValue([]);
  dbMock.fundamentalsSnapshot.upsert = vi.fn().mockResolvedValue({});
  dbMock.fundamentalsSnapshot.findUnique = vi.fn().mockResolvedValue(null);
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe("extractFundamentals", () => {
  it("normalises Finnhub's millions market cap into absolute USD", async () => {
    const mod = await import("@/lib/fundamentals-source");
    const out = mod.extractFundamentals({
      metric: { marketCapitalization: 1500, epsTTM: 2.0, peTTM: 30 },
    });
    expect(out.marketCap).toBe(1_500_000_000);
    expect(out.epsTtm).toBe(2.0);
    expect(out.peRatio).toBe(30);
    expect(out.hasReportedEarnings).toBe(true);
  });

  it("nulls out non-finite values", async () => {
    const mod = await import("@/lib/fundamentals-source");
    const out = mod.extractFundamentals({
      metric: {
        marketCapitalization: NaN,
        epsTTM: "n/a",
        peTTM: undefined,
      },
    });
    expect(out.marketCap).toBeNull();
    expect(out.epsTtm).toBeNull();
    expect(out.peRatio).toBeNull();
    expect(out.hasReportedEarnings).toBe(false);
  });

  it("survives an empty/missing metric blob", async () => {
    const mod = await import("@/lib/fundamentals-source");
    const out = mod.extractFundamentals({});
    expect(out.marketCap).toBeNull();
    expect(out.epsTtm).toBeNull();
    expect(out.hasReportedEarnings).toBe(false);
  });
});

describe("refreshAllFundamentals", () => {
  it("skips when no API key is set", async () => {
    delete process.env.FINNHUB_API_KEY;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;
    const mod = await import("@/lib/fundamentals-source");
    const r = await mod.refreshAllFundamentals();
    expect(r.total).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMock.fundamentalsSnapshot.upsert).not.toHaveBeenCalled();
  });

  it("fetches and persists for each watchlist symbol", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAA" },
      { symbol: "BBB" },
    ]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        metric: {
          marketCapitalization: 1000,
          epsTTM: 1.5,
          peTTM: 25,
          "totalDebt/totalEquityAnnual": 0.8,
        },
      }),
    }) as any;

    const mod = await import("@/lib/fundamentals-source");
    const r = await mod.refreshAllFundamentals();
    expect(r.succeeded).toBe(2);
    expect(r.rateLimited).toBe(0);
    expect(r.errored).toBe(0);
    expect(dbMock.fundamentalsSnapshot.upsert).toHaveBeenCalledTimes(2);
  });

  it("classifies 429 as rate_limited", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue([{ symbol: "X" }]);
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 429, statusText: "rate" }) as any;
    const mod = await import("@/lib/fundamentals-source");
    const r = await mod.refreshAllFundamentals();
    expect(r.rateLimited).toBe(1);
    expect(r.succeeded).toBe(0);
  });

  it("classifies network errors as errored", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue([{ symbol: "X" }]);
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET")) as any;
    const mod = await import("@/lib/fundamentals-source");
    const r = await mod.refreshAllFundamentals();
    expect(r.errored).toBe(1);
  });

  it("survives upsert failure (logged, errored++)", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue([{ symbol: "X" }]);
    dbMock.fundamentalsSnapshot.upsert.mockRejectedValueOnce(
      new Error("boom")
    );
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ metric: { marketCapitalization: 100, epsTTM: 1 } }),
    }) as any;
    const mod = await import("@/lib/fundamentals-source");
    const r = await mod.refreshAllFundamentals();
    expect(r.errored).toBe(1);
    expect(r.succeeded).toBe(0);
  });

  it("makes calls strictly serially", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue(
      [..."ABCD"].map((c) => ({ symbol: `S${c}` }))
    );
    let inFlight = 0;
    let max = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, status: 200, json: async () => ({ metric: {} }) };
    }) as any;
    const mod = await import("@/lib/fundamentals-source");
    await mod.refreshAllFundamentals();
    expect(max).toBe(1);
  });

  it("emits refresh.progress every N symbols", async () => {
    process.env.FINNHUB_API_KEY = "k";
    const stocks = Array.from({ length: 51 }, (_, i) => ({ symbol: `S${i}` }));
    dbMock.watchlistStock.findMany.mockResolvedValue(stocks);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ metric: {} }),
    }) as any;
    const logger = await import("@/lib/logger");
    const sink = vi.fn();
    logger.setLoggerSink(sink);
    const mod = await import("@/lib/fundamentals-source");
    await mod.refreshAllFundamentals();
    const progress = sink.mock.calls.filter(
      (c) => c[0]?.event === "refresh.progress"
    );
    expect(progress.length).toBeGreaterThanOrEqual(1);
    logger.resetLoggerSink();
  });
});

describe("getFundamentalsForSymbol", () => {
  it("returns null when no row exists (cold start)", async () => {
    dbMock.fundamentalsSnapshot.findUnique.mockResolvedValue(null);
    const mod = await import("@/lib/fundamentals-source");
    const r = await mod.getFundamentalsForSymbol("X");
    expect(r).toBeNull();
  });

  it("returns the row mapped to Fundamentals shape", async () => {
    dbMock.fundamentalsSnapshot.findUnique.mockResolvedValue({
      symbol: "X",
      marketCap: 500_000_000,
      peRatio: 22,
      debtToEquity: 1.5,
      freeCashFlowTtm: null,
      epsTtm: 2.1,
      revenueGrowthYoy: 7,
      hasReportedEarnings: true,
      fetchedAt: new Date(),
    });
    const mod = await import("@/lib/fundamentals-source");
    const r = await mod.getFundamentalsForSymbol("X");
    expect(r).toEqual({
      marketCap: 500_000_000,
      peRatio: 22,
      debtToEquity: 1.5,
      freeCashFlowTtm: null,
      epsTtm: 2.1,
      revenueGrowthYoy: 7,
      hasReportedEarnings: true,
    });
  });
});
