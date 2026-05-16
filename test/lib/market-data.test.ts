import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const yfMock: { quote: any; chart: any } = {
  quote: vi.fn(),
  chart: vi.fn(),
};

vi.mock("yahoo-finance2", () => {
  return {
    default: function () {
      return yfMock;
    },
  };
});

const dbMock = {
  priceCache: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
};

vi.mock("@/lib/db", () => ({ db: dbMock }));

describe("market-data", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    // Reassign fresh mocks each test to avoid clearAllMocks affecting impls
    yfMock.quote = vi.fn();
    yfMock.chart = vi.fn();
    dbMock.priceCache.findFirst = vi.fn();
    dbMock.priceCache.create = vi.fn();
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it("returns cached quote when fresh", async () => {
    const fetchedAt = new Date();
    dbMock.priceCache.findFirst.mockResolvedValue({
      symbol: "AAPL",
      price: 100,
      change: 1,
      changePct: 1,
      volume: 1000,
      high: 101,
      low: 99,
      fetchedAt,
    });

    const { getQuote } = await import("@/lib/market-data");
    const q = await getQuote("AAPL");
    expect(q.price).toBe(100);
    expect(yfMock.quote).not.toHaveBeenCalled();
  });

  it("fetches from Yahoo when cache stale", async () => {
    dbMock.priceCache.findFirst.mockResolvedValue({
      symbol: "AAPL",
      price: 50,
      change: 0,
      changePct: 0,
      volume: 0,
      high: 0,
      low: 0,
      fetchedAt: new Date(Date.now() - 10 * 60_000),
    });
    yfMock.quote.mockResolvedValue({
      regularMarketPrice: 200,
      regularMarketChange: 5,
      regularMarketChangePercent: 2.5,
      regularMarketDayHigh: 205,
      regularMarketDayLow: 195,
      regularMarketOpen: 198,
      regularMarketPreviousClose: 195,
      regularMarketVolume: 12345,
      marketCap: 9_999,
    });
    dbMock.priceCache.create.mockResolvedValue({});

    const { getQuote } = await import("@/lib/market-data");
    const q = await getQuote("AAPL");
    expect(q.price).toBe(200);
    expect(q.marketCap).toBe(9999);
    expect(dbMock.priceCache.create).toHaveBeenCalled();
  });

  it("fetches from Yahoo with no cached row, with default fallbacks", async () => {
    dbMock.priceCache.findFirst.mockResolvedValue(null);
    yfMock.quote.mockResolvedValue({});
    dbMock.priceCache.create.mockResolvedValue({});

    const { getQuote } = await import("@/lib/market-data");
    const q = await getQuote("X");
    expect(q.price).toBe(0);
    expect(q.change).toBe(0);
    expect(q.changePct).toBe(0);
    expect(q.high).toBe(0);
    expect(q.low).toBe(0);
    expect(q.open).toBe(0);
    expect(q.prevClose).toBe(0);
    expect(q.volume).toBe(0);
  });

  it("returns stale cache on Yahoo error when no Polygon key", async () => {
    delete process.env.POLYGON_API_KEY;
    const fetchedAt = new Date(Date.now() - 10 * 60_000);
    dbMock.priceCache.findFirst.mockResolvedValue({
      symbol: "X",
      price: 7,
      change: 0,
      changePct: 0,
      volume: 0,
      high: 0,
      low: 0,
      fetchedAt,
    });
    yfMock.quote.mockRejectedValue(new Error("yahoo down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { getQuote } = await import("@/lib/market-data");
    const q = await getQuote("X");
    expect(q.price).toBe(7);
  });

  it("throws when Yahoo fails and no cache", async () => {
    delete process.env.POLYGON_API_KEY;
    dbMock.priceCache.findFirst.mockResolvedValue(null);
    yfMock.quote.mockRejectedValue(new Error("nope"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { getQuote } = await import("@/lib/market-data");
    await expect(getQuote("Z")).rejects.toThrow("No data available");
  });

  it("falls back to Polygon when Yahoo fails and key set", async () => {
    process.env.POLYGON_API_KEY = "key";
    dbMock.priceCache.findFirst.mockResolvedValue(null);
    yfMock.quote.mockRejectedValue(new Error("yahoo down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        results: [{ c: 110, o: 100, h: 115, l: 99, v: 5000 }],
      }),
    }) as any;

    const { getQuote } = await import("@/lib/market-data");
    const q = await getQuote("PG");
    expect(q.price).toBe(110);
    expect(q.changePct).toBeCloseTo(10, 5);
  });

  it("Polygon throws when no result", async () => {
    process.env.POLYGON_API_KEY = "key";
    dbMock.priceCache.findFirst.mockResolvedValue(null);
    yfMock.quote.mockRejectedValue(new Error("yahoo"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({}),
    }) as any;

    const { getQuote } = await import("@/lib/market-data");
    await expect(getQuote("X")).rejects.toThrow();
  });

  it("getQuotes batches and returns fulfilled values", async () => {
    dbMock.priceCache.findFirst.mockResolvedValue(null);
    yfMock.quote.mockResolvedValue({
      regularMarketPrice: 1,
      regularMarketChange: 0,
      regularMarketChangePercent: 0,
      regularMarketDayHigh: 0,
      regularMarketDayLow: 0,
      regularMarketOpen: 0,
      regularMarketPreviousClose: 0,
      regularMarketVolume: 0,
    });
    dbMock.priceCache.create.mockResolvedValue({});

    const { getQuotes } = await import("@/lib/market-data");
    const symbols = ["A", "B", "C", "D", "E", "F", "G"];
    const out = await getQuotes(symbols);
    expect(out.length).toBe(7);
  });

  it("getQuotes skips rejected results", async () => {
    delete process.env.POLYGON_API_KEY;
    dbMock.priceCache.findFirst.mockResolvedValue(null);
    yfMock.quote.mockRejectedValue(new Error("fail"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { getQuotes } = await import("@/lib/market-data");
    const out = await getQuotes(["X", "Y"]);
    expect(out).toEqual([]);
  });

  it("getHistory returns mapped bars from Yahoo", async () => {
    yfMock.chart.mockResolvedValue({
      quotes: [
        {
          date: new Date("2026-01-01T00:00:00Z"),
          open: 1,
          high: 2,
          low: 0.5,
          close: 1.5,
          volume: 10,
        },
        { date: new Date("2026-01-02T00:00:00Z") }, // missing fields → 0 fallback
      ],
    });

    const { getHistory } = await import("@/lib/market-data");
    const bars = await getHistory("X", 10);
    expect(bars.length).toBe(2);
    expect(bars[0].close).toBe(1.5);
    expect(bars[1].open).toBe(0);
  });

  it("getHistory uses default days arg and handles missing quotes", async () => {
    yfMock.chart.mockResolvedValue({});
    const { getHistory } = await import("@/lib/market-data");
    const bars = await getHistory("X");
    expect(bars).toEqual([]);
  });

  it("getHistory returns [] on error when no Polygon", async () => {
    delete process.env.POLYGON_API_KEY;
    yfMock.chart.mockRejectedValue(new Error("yahoo down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { getHistory } = await import("@/lib/market-data");
    const bars = await getHistory("X", 5);
    expect(bars).toEqual([]);
  });

  it("getHistory falls back to Polygon when key set", async () => {
    process.env.POLYGON_API_KEY = "k";
    yfMock.chart.mockRejectedValue(new Error("yahoo down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue({
      json: async () => ({
        results: [
          { t: Date.parse("2026-01-01"), o: 1, h: 2, l: 0.5, c: 1.2, v: 9 },
        ],
      }),
    }) as any;

    const { getHistory } = await import("@/lib/market-data");
    const bars = await getHistory("X", 5);
    expect(bars.length).toBe(1);
    expect(bars[0].close).toBe(1.2);
  });

  it("getHistory Polygon empty results", async () => {
    process.env.POLYGON_API_KEY = "k";
    yfMock.chart.mockRejectedValue(new Error("yahoo"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue({ json: async () => ({}) }) as any;
    const { getHistory } = await import("@/lib/market-data");
    const bars = await getHistory("X", 5);
    expect(bars).toEqual([]);
  });
});
