import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMock: any = {
  newsItem: { findMany: vi.fn() },
};
vi.mock("@/lib/db", () => ({ db: dbMock }));

beforeEach(() => {
  vi.resetModules();
  dbMock.newsItem.findMany = vi.fn();
});

function makeReq() {
  return {} as any;
}

describe("GET /api/news/[symbol]", () => {
  it("returns 400 for an invalid symbol", async () => {
    const { GET } = await import("@/app/api/news/[symbol]/route");
    const r = await GET(makeReq(), { params: { symbol: "<script>" } });
    expect(r.status).toBe(400);
    expect(dbMock.newsItem.findMany).not.toHaveBeenCalled();
  });

  it("returns 400 for empty symbol", async () => {
    const { GET } = await import("@/app/api/news/[symbol]/route");
    const r = await GET(makeReq(), { params: { symbol: "" } });
    expect(r.status).toBe(400);
  });

  it("uppercases the symbol and returns rows ordered by publishedAt desc", async () => {
    dbMock.newsItem.findMany.mockResolvedValue([
      {
        id: "1",
        headline: "Big news",
        summary: "summary",
        source: "Reuters",
        url: "https://x",
        publishedAt: new Date("2026-04-27T10:00:00Z"),
      },
    ]);
    const { GET } = await import("@/app/api/news/[symbol]/route");
    const r = await GET(makeReq(), { params: { symbol: "aapl" } });
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.symbol).toBe("AAPL");
    expect(body.count).toBe(1);
    expect(body.items[0].headline).toBe("Big news");
    const args = dbMock.newsItem.findMany.mock.calls[0][0];
    expect(args.where.symbol).toBe("AAPL");
    expect(args.orderBy.publishedAt).toBe("desc");
  });

  it("returns empty list when no rows", async () => {
    dbMock.newsItem.findMany.mockResolvedValue([]);
    const { GET } = await import("@/app/api/news/[symbol]/route");
    const r = await GET(makeReq(), { params: { symbol: "X" } });
    const body = await r.json();
    expect(body.count).toBe(0);
    expect(body.items).toEqual([]);
  });

  it("returns 500 on db error", async () => {
    dbMock.newsItem.findMany.mockRejectedValue(new Error("boom"));
    const { GET } = await import("@/app/api/news/[symbol]/route");
    const r = await GET(makeReq(), { params: { symbol: "X" } });
    expect(r.status).toBe(500);
  });

  it("accepts symbols with dots and hyphens (e.g. BRK.B, ^IXIC)", async () => {
    dbMock.newsItem.findMany.mockResolvedValue([]);
    const { GET } = await import("@/app/api/news/[symbol]/route");
    const r1 = await GET(makeReq(), { params: { symbol: "BRK.B" } });
    expect(r1.status).toBe(200);
    const r2 = await GET(makeReq(), { params: { symbol: "^IXIC" } });
    expect(r2.status).toBe(200);
  });
});
