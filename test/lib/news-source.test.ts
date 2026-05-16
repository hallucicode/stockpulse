import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Speed: shrink request spacing + rate-limit backoff so tests don't actually
// wait. Defaults are 1100ms / 60s; tests set both to 0.
vi.mock("@/lib/config", async () => {
  const real: any = await vi.importActual("@/lib/config");
  return {
    ...real,
    NEWS_CONFIG: {
      ...real.NEWS_CONFIG,
      requestSpacingMs: 0,
      rateLimitBackoffMs: 0,
    },
  };
});

const dbMock: any = {
  watchlistStock: { findMany: vi.fn() },
  newsItem: {
    upsert: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
    aggregate: vi.fn().mockResolvedValue({ _max: { fetchedAt: null } }),
  },
  diagnosisCache: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
};
vi.mock("@/lib/db", () => ({ db: dbMock }));

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  dbMock.watchlistStock.findMany = vi.fn().mockResolvedValue([]);
  dbMock.newsItem.upsert = vi.fn().mockResolvedValue({});
  dbMock.newsItem.deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  dbMock.newsItem.findMany = vi.fn().mockResolvedValue([]);
  dbMock.diagnosisCache.findUnique = vi.fn().mockResolvedValue(null);
  dbMock.diagnosisCache.upsert = vi.fn().mockResolvedValue({});
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

describe("refreshNewsForWatchlist", () => {
  it("skips with no API key (single info log, no DB writes)", async () => {
    delete process.env.FINNHUB_API_KEY;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;

    const mod = await import("@/lib/news-source");
    const r = await mod.refreshNewsForWatchlist();
    expect(r.total).toBe(0);
    expect(r.succeeded).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(dbMock.newsItem.upsert).not.toHaveBeenCalled();
  });

  it("fetches and persists news rows for each watchlist symbol", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAA", addedAt: new Date() },
      { symbol: "BBB", addedAt: new Date() },
    ]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: 100,
          headline: "Acme misses estimates",
          summary: "...",
          source: "Reuters",
          url: "https://x",
          datetime: 1_700_000_000,
          category: "company",
        },
      ],
    }) as any;

    const mod = await import("@/lib/news-source");
    const r = await mod.refreshNewsForWatchlist();
    expect(r.succeeded).toBe(2);
    expect(r.rateLimited).toBe(0);
    expect(r.errored).toBe(0);
    expect(dbMock.newsItem.upsert).toHaveBeenCalledTimes(2);
  });

  it("classifies 429 as rate_limited and other failures as errored", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAA" },
      { symbol: "BBB" },
      { symbol: "CCC" },
    ]);
    let call = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) return { ok: false, status: 429, statusText: "rate" };
      if (call === 2) return { ok: false, status: 500, statusText: "boom" };
      return { ok: true, status: 200, json: async () => [] };
    }) as any;

    const mod = await import("@/lib/news-source");
    const r = await mod.refreshNewsForWatchlist();
    expect(r.rateLimited).toBe(1);
    expect(r.errored).toBe(1);
    expect(r.succeeded).toBe(1);
  });

  it("classifies network errors as errored (not succeeded)", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue([{ symbol: "X" }]);
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET")) as any;

    const mod = await import("@/lib/news-source");
    const r = await mod.refreshNewsForWatchlist();
    expect(r.errored).toBe(1);
    expect(r.succeeded).toBe(0);
  });

  it("emits refresh.progress every N symbols", async () => {
    process.env.FINNHUB_API_KEY = "k";
    // 51 symbols → expect at least one progress event at index 50 (1-based).
    const stocks = Array.from({ length: 51 }, (_, i) => ({ symbol: `S${i}` }));
    dbMock.watchlistStock.findMany.mockResolvedValue(stocks);
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => [] }) as any;

    const logger = await import("@/lib/logger");
    const sink = vi.fn();
    logger.setLoggerSink(sink);

    const mod = await import("@/lib/news-source");
    await mod.refreshNewsForWatchlist();

    const progressCalls = sink.mock.calls.filter(
      (c) => c[0]?.event === "refresh.progress"
    );
    expect(progressCalls.length).toBeGreaterThanOrEqual(1);
    expect(progressCalls[0][0].meta).toMatchObject({
      processed: 50,
      total: 51,
    });
    logger.resetLoggerSink();
  });

  it("makes calls strictly serially (rate-limit safety)", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAA" },
      { symbol: "BBB" },
      { symbol: "CCC" },
    ]);
    let inFlight = 0;
    let maxInFlight = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, status: 200, json: async () => [] };
    }) as any;

    const mod = await import("@/lib/news-source");
    await mod.refreshNewsForWatchlist();
    expect(maxInFlight).toBe(1);
  });

  it("ignores rows missing id or headline", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue([{ symbol: "X" }]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { id: 0, headline: "no id", datetime: 1 }, // bad: id == 0
        { id: 5, headline: "", datetime: 1 }, // bad: empty headline
        { id: 6, headline: "ok", datetime: 1_700_000_000 }, // good
      ],
    }) as any;

    const mod = await import("@/lib/news-source");
    await mod.refreshNewsForWatchlist();
    expect(dbMock.newsItem.upsert).toHaveBeenCalledTimes(1);
  });

  it("survives upsert failures (logged, continues)", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue([{ symbol: "X" }]);
    dbMock.newsItem.upsert.mockRejectedValueOnce(new Error("dup"));
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        { id: 1, headline: "h1", datetime: 1_700_000_000 },
        { id: 2, headline: "h2", datetime: 1_700_000_001 },
      ],
    }) as any;

    const mod = await import("@/lib/news-source");
    const r = await mod.refreshNewsForWatchlist();
    expect(r.succeeded).toBe(1); // the symbol still processed; rows just skip
  });

  it("treats non-array response as zero rows (no crash)", async () => {
    process.env.FINNHUB_API_KEY = "k";
    dbMock.watchlistStock.findMany.mockResolvedValue([{ symbol: "X" }]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ error: "bad params" }),
    }) as any;

    const mod = await import("@/lib/news-source");
    await expect(mod.refreshNewsForWatchlist()).resolves.toMatchObject({
      succeeded: 1,
    });
  });
});

describe("getOrCacheDiagnosis", () => {
  it("returns cached row when newsHash matches", async () => {
    dbMock.diagnosisCache.findUnique.mockResolvedValue({
      symbol: "X",
      category: "fraud",
      rationale: "cached rationale",
      scoreAdjustment: -40,
      newsCount: 2,
      // The hash is computed inside the function. We don't know it ahead of
      // time, so use the same headlines on both sides and cheat by matching
      // whatever the function asks for. Easier: do this by spying.
      newsHash: "to-be-set",
    });

    const mod = await import("@/lib/news-source");

    // First, run with a known headline list to learn the hash.
    const fresh = await mod.getOrCacheDiagnosis("X", ["headline 1"]);
    // The first call computed and persisted — pull the hash out.
    const persistedHash =
      dbMock.diagnosisCache.upsert.mock.calls[0][0].create.newsHash;
    expect(typeof persistedHash).toBe("string");

    // Now arrange a real cache hit by replaying the same headlines with the
    // hash we just learned.
    dbMock.diagnosisCache.findUnique.mockResolvedValue({
      symbol: "X",
      category: "fraud",
      rationale: "cached rationale",
      scoreAdjustment: -40,
      newsCount: 2,
      newsHash: persistedHash,
    });
    dbMock.diagnosisCache.upsert.mockClear();

    const cached = await mod.getOrCacheDiagnosis("X", ["headline 1"]);
    expect(cached.category).toBe("fraud");
    expect(cached.rationale).toBe("cached rationale");
    // No write on a cache hit.
    expect(dbMock.diagnosisCache.upsert).not.toHaveBeenCalled();
  });

  it("recomputes and persists when no cached row exists", async () => {
    dbMock.diagnosisCache.findUnique.mockResolvedValue(null);
    const mod = await import("@/lib/news-source");
    const r = await mod.getOrCacheDiagnosis("X", ["WidgetCo cuts guidance"]);
    expect(r.category).toBe("guidance_cut");
    expect(dbMock.diagnosisCache.upsert).toHaveBeenCalledTimes(1);
  });

  it("recomputes when newsHash differs from cache (headlines changed)", async () => {
    dbMock.diagnosisCache.findUnique.mockResolvedValue({
      symbol: "X",
      category: "fraud",
      rationale: "stale",
      scoreAdjustment: -40,
      newsCount: 1,
      newsHash: "totally-different-hash",
    });
    const mod = await import("@/lib/news-source");
    const r = await mod.getOrCacheDiagnosis("X", ["BigCo to acquire SmallCo"]);
    expect(r.category).toBe("merger");
    expect(dbMock.diagnosisCache.upsert).toHaveBeenCalledTimes(1);
  });

  it("returns technical_only for empty headlines and does NOT cache it", async () => {
    const mod = await import("@/lib/news-source");
    const r = await mod.getOrCacheDiagnosis("X", []);
    expect(r.category).toBe("technical_only");
    // Skipping the write on empty input is the cold-start race fix —
    // see news-source.ts comment.
    expect(dbMock.diagnosisCache.upsert).not.toHaveBeenCalled();
  });

  it("falls through to fresh compute when cache READ fails", async () => {
    dbMock.diagnosisCache.findUnique.mockRejectedValue(new Error("db down"));
    const mod = await import("@/lib/news-source");
    const r = await mod.getOrCacheDiagnosis("X", ["BigCo misses estimates"]);
    expect(r.category).toBe("earnings_miss");
  });

  it("returns fresh result even when cache WRITE fails", async () => {
    dbMock.diagnosisCache.findUnique.mockResolvedValue(null);
    dbMock.diagnosisCache.upsert.mockRejectedValue(new Error("write fail"));
    const mod = await import("@/lib/news-source");
    await expect(
      mod.getOrCacheDiagnosis("X", ["BigCo lawsuit filed"])
    ).resolves.toMatchObject({ category: "lawsuit" });
  });
});

describe("getNewsHealth", () => {
  it("returns isMissing=true when newsItem table is empty", async () => {
    dbMock.newsItem.aggregate = vi.fn().mockResolvedValue({ _max: { fetchedAt: null } });
    const mod = await import("@/lib/news-source");
    const h = await mod.getNewsHealth();
    expect(h.isMissing).toBe(true);
    expect(h.isStale).toBe(true);
    expect(h.lastIngestAt).toBeNull();
    expect(h.ageHours).toBeNull();
  });

  it("returns isStale=false when latest ingest is recent", async () => {
    const now = new Date("2026-04-27T12:00:00Z");
    const recent = new Date("2026-04-27T08:00:00Z"); // 4h old
    dbMock.newsItem.aggregate = vi.fn().mockResolvedValue({ _max: { fetchedAt: recent } });
    const mod = await import("@/lib/news-source");
    const h = await mod.getNewsHealth(now);
    expect(h.isMissing).toBe(false);
    expect(h.isStale).toBe(false);
    expect(h.ageHours).toBe(4);
  });

  it("returns isStale=true beyond the threshold", async () => {
    const now = new Date("2026-04-27T12:00:00Z");
    const old = new Date("2026-04-25T12:00:00Z"); // 48h old
    dbMock.newsItem.aggregate = vi.fn().mockResolvedValue({ _max: { fetchedAt: old } });
    const mod = await import("@/lib/news-source");
    const h = await mod.getNewsHealth(now);
    expect(h.isStale).toBe(true);
    expect(h.ageHours).toBe(48);
  });
});

describe("getRecentNewsForSymbol", () => {
  it("queries with the lookback window and returns rows", async () => {
    dbMock.newsItem.findMany.mockResolvedValue([
      { headline: "h", publishedAt: new Date() },
    ]);
    const mod = await import("@/lib/news-source");
    const rows = await mod.getRecentNewsForSymbol("X");
    expect(rows).toHaveLength(1);
    const args = dbMock.newsItem.findMany.mock.calls[0][0];
    expect(args.where.symbol).toBe("X");
    expect(args.where.publishedAt.gte).toBeInstanceOf(Date);
  });
});
