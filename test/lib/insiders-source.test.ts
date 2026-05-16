import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", async () => {
  const real: any = await vi.importActual("@/lib/config");
  return {
    ...real,
    INSIDERS_CONFIG: {
      ...real.INSIDERS_CONFIG,
      requestSpacingMs: 0,
      rateLimitBackoffMs: 0,
    },
  };
});

const dbMock: any = {
  watchlistStock: { findMany: vi.fn() },
  insiderTransaction: {
    upsert: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
  },
};
vi.mock("@/lib/db", () => ({ db: dbMock }));

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  dbMock.watchlistStock.findMany = vi.fn().mockResolvedValue([]);
  dbMock.insiderTransaction.upsert = vi.fn().mockResolvedValue({});
  dbMock.insiderTransaction.deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  dbMock.insiderTransaction.findMany = vi.fn().mockResolvedValue([]);
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe("refreshAllInsiders", () => {
  it("skips when API key not set", async () => {
    delete process.env.FINNHUB_API_KEY;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;
    const mod = await import("@/lib/insiders-source");
    const r = await mod.refreshAllInsiders();
    expect(r.total).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches and persists rows for each watchlist symbol", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAA" },
      { symbol: "BBB" },
    ]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            name: "Cook Tim",
            change: 1000,
            transactionDate: "2026-04-12",
            transactionCode: "P",
            transactionPrice: 175,
          },
        ],
      }),
    }) as any;

    const mod = await import("@/lib/insiders-source");
    const r = await mod.refreshAllInsiders();
    expect(r.succeeded).toBe(2);
    expect(dbMock.insiderTransaction.upsert).toHaveBeenCalledTimes(2);
  });

  it("classifies 429 as rate_limited", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue([{ symbol: "X" }]);
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 429, statusText: "rate" }) as any;
    const mod = await import("@/lib/insiders-source");
    const r = await mod.refreshAllInsiders();
    expect(r.rateLimited).toBe(1);
  });

  it("classifies network errors as errored", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue([{ symbol: "X" }]);
    global.fetch = vi.fn().mockRejectedValue(new Error("net")) as any;
    const mod = await import("@/lib/insiders-source");
    const r = await mod.refreshAllInsiders();
    expect(r.errored).toBe(1);
  });

  it("ignores rows with zero change or missing date", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue([{ symbol: "X" }]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { name: "A", change: 0, transactionDate: "2026-04-12" }, // skip
          { name: "B", change: 10, transactionDate: null }, // skip
          { name: "C", change: 100, transactionDate: "2026-04-12" }, // ok
        ],
      }),
    }) as any;
    const mod = await import("@/lib/insiders-source");
    await mod.refreshAllInsiders();
    expect(dbMock.insiderTransaction.upsert).toHaveBeenCalledTimes(1);
  });

  it("survives non-array `data` field", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue([{ symbol: "X" }]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: null }),
    }) as any;
    const mod = await import("@/lib/insiders-source");
    const r = await mod.refreshAllInsiders();
    expect(r.succeeded).toBe(1);
    expect(dbMock.insiderTransaction.upsert).not.toHaveBeenCalled();
  });

  it("makes calls strictly serially", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue(
      [..."ABC"].map((c) => ({ symbol: `S${c}` }))
    );
    let inFlight = 0;
    let max = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }) as any;
    const mod = await import("@/lib/insiders-source");
    await mod.refreshAllInsiders();
    expect(max).toBe(1);
  });
});

describe("getRecentInsiderTxnsForSymbol", () => {
  it("maps DB rows to InsiderTxn shape", async () => {
    dbMock.insiderTransaction.findMany.mockResolvedValue([
      {
        filerName: "Alice",
        transactionDate: new Date("2026-04-20"),
        transactionCode: "P",
        shareChange: 1000,
        totalValue: 175_000,
      },
    ]);
    const mod = await import("@/lib/insiders-source");
    const out = await mod.getRecentInsiderTxnsForSymbol("X");
    expect(out).toHaveLength(1);
    expect(out[0].filerName).toBe("Alice");
    expect(out[0].shareChange).toBe(1000);
  });
});
