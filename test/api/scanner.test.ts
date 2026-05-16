import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMock: any = {
  analysisCache: { findMany: vi.fn() },
  newsItem: { aggregate: vi.fn() },
  regimeSnapshot: { findFirst: vi.fn() },
};

vi.mock("@/lib/db", () => ({ db: dbMock }));

beforeEach(() => {
  dbMock.analysisCache.findMany = vi.fn();
  // Default: news data fresh enough to be invisible to existing tests.
  dbMock.newsItem.aggregate = vi
    .fn()
    .mockResolvedValue({ _max: { fetchedAt: new Date() } });
  // Default: no regime snapshot (existing tests don't care).
  dbMock.regimeSnapshot.findFirst = vi.fn().mockResolvedValue(null);
});

function makeReq(qs = "") {
  return { nextUrl: { searchParams: new URLSearchParams(qs) } } as any;
}

describe("GET /api/scanner", () => {
  it("returns empty when no cache", async () => {
    dbMock.analysisCache.findMany.mockResolvedValue([]);
    const { GET } = await import("@/app/api/scanner/route");
    const r = await GET(makeReq());
    const j = await r.json();
    expect(j.stocks).toEqual([]);
    expect(j.lastUpdated).toBeNull();
    expect(j.count).toBe(0);
    expect(j.vetoedCount).toBe(0);
  });

  it("parses cached entries and computes oldest fetchedAt", async () => {
    const t1 = new Date("2026-01-01T00:00:00Z");
    const t2 = new Date("2026-01-02T00:00:00Z");
    dbMock.analysisCache.findMany.mockResolvedValue([
      {
        symbol: "A",
        data: JSON.stringify({ symbol: "A", analysis: { price: 10 } }),
        fetchedAt: t2,
      },
      {
        symbol: "B",
        data: JSON.stringify({ symbol: "B", analysis: { price: 0 } }),
        fetchedAt: t1,
      },
      {
        symbol: "C",
        data: JSON.stringify({ symbol: "C", analysis: { price: 5 } }),
        fetchedAt: t1,
      },
    ]);
    const { GET } = await import("@/app/api/scanner/route");
    const r = await GET(makeReq());
    const j = await r.json();
    expect(j.count).toBe(2); // B is filtered (price 0)
    expect(j.lastUpdated).toBe(t1.toISOString());
  });

  it("hides vetoed stocks by default and reports the count", async () => {
    const t = new Date("2026-04-27T00:00:00Z");
    dbMock.analysisCache.findMany.mockResolvedValue([
      {
        symbol: "GOOD",
        data: JSON.stringify({ symbol: "GOOD", analysis: { price: 10 } }),
        fetchedAt: t,
      },
      {
        symbol: "TRASH",
        data: JSON.stringify({
          symbol: "TRASH",
          analysis: {
            price: 0.5,
            qualityVeto: { reason: "parabolic_up", detail: "..." },
          },
        }),
        fetchedAt: t,
      },
    ]);
    const { GET } = await import("@/app/api/scanner/route");
    const r = await GET(makeReq());
    const j = await r.json();
    expect(j.count).toBe(1);
    expect(j.vetoedCount).toBe(1);
    expect(j.stocks.map((s: { symbol: string }) => s.symbol)).toEqual(["GOOD"]);
  });

  it("?includeVetoed=true returns the vetoed stocks too", async () => {
    const t = new Date("2026-04-27T00:00:00Z");
    dbMock.analysisCache.findMany.mockResolvedValue([
      {
        symbol: "GOOD",
        data: JSON.stringify({ symbol: "GOOD", analysis: { price: 10 } }),
        fetchedAt: t,
      },
      {
        symbol: "TRASH",
        data: JSON.stringify({
          symbol: "TRASH",
          analysis: {
            price: 0.5,
            qualityVeto: { reason: "parabolic_up", detail: "..." },
          },
        }),
        fetchedAt: t,
      },
    ]);
    const { GET } = await import("@/app/api/scanner/route");
    const r = await GET(makeReq("includeVetoed=true"));
    const j = await r.json();
    expect(j.count).toBe(2);
    expect(j.vetoedCount).toBe(1);
  });

  it("includes newsHealth.isMissing=true when newsItem table is empty", async () => {
    dbMock.analysisCache.findMany.mockResolvedValue([]);
    dbMock.newsItem.aggregate.mockResolvedValue({ _max: { fetchedAt: null } });
    const { GET } = await import("@/app/api/scanner/route");
    const r = await GET(makeReq());
    const j = await r.json();
    expect(j.newsHealth.isMissing).toBe(true);
    expect(j.newsHealth.isStale).toBe(true);
  });

  it("includes newsHealth.isStale=false when news is fresh", async () => {
    dbMock.analysisCache.findMany.mockResolvedValue([
      {
        symbol: "X",
        data: JSON.stringify({ symbol: "X", analysis: { price: 50 } }),
        fetchedAt: new Date(),
      },
    ]);
    dbMock.newsItem.aggregate.mockResolvedValue({
      _max: { fetchedAt: new Date(Date.now() - 60_000) }, // 1 min ago
    });
    const { GET } = await import("@/app/api/scanner/route");
    const r = await GET(makeReq());
    const j = await r.json();
    expect(j.newsHealth.isStale).toBe(false);
    expect(j.newsHealth.isMissing).toBe(false);
  });

  it("degrades gracefully when newsHealth lookup fails", async () => {
    dbMock.analysisCache.findMany.mockResolvedValue([]);
    dbMock.newsItem.aggregate.mockRejectedValue(new Error("db down"));
    const { GET } = await import("@/app/api/scanner/route");
    const r = await GET(makeReq());
    expect(r.status).toBe(200); // never break the scanner because of this
    const j = await r.json();
    expect(j.newsHealth).toBeNull();
  });

  it("includes the current regime when a snapshot exists", async () => {
    dbMock.analysisCache.findMany.mockResolvedValue([]);
    dbMock.regimeSnapshot.findFirst.mockResolvedValue({
      regime: "trending_up",
      fetchedAt: new Date(),
    });
    const { GET } = await import("@/app/api/scanner/route");
    const r = await GET(makeReq());
    const j = await r.json();
    expect(j.regime).toBe("trending_up");
  });

  it("returns regime=null when no snapshot exists (cold start)", async () => {
    dbMock.analysisCache.findMany.mockResolvedValue([]);
    dbMock.regimeSnapshot.findFirst.mockResolvedValue(null);
    const { GET } = await import("@/app/api/scanner/route");
    const r = await GET(makeReq());
    const j = await r.json();
    expect(j.regime).toBeNull();
  });

  it("degrades gracefully when the regime lookup throws", async () => {
    dbMock.analysisCache.findMany.mockResolvedValue([]);
    dbMock.regimeSnapshot.findFirst.mockRejectedValue(new Error("db"));
    const { GET } = await import("@/app/api/scanner/route");
    const r = await GET(makeReq());
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.regime).toBeNull();
  });

  it("returns 500 on db error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbMock.analysisCache.findMany.mockRejectedValue(new Error("boom"));
    const { GET } = await import("@/app/api/scanner/route");
    const r = await GET(makeReq());
    expect(r.status).toBe(500);
    const j = await r.json();
    expect(j.error).toBeDefined();
  });
});
