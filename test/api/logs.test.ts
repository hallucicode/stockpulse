import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMock: any = {
  logEntry: { findMany: vi.fn(), findFirst: vi.fn() },
};
vi.mock("@/lib/db", () => ({ db: dbMock }));

beforeEach(() => {
  vi.resetModules();
  dbMock.logEntry.findMany = vi.fn().mockResolvedValue([]);
  dbMock.logEntry.findFirst = vi.fn().mockResolvedValue(null);
});

function makeRequest(qs = "") {
  return { nextUrl: { searchParams: new URLSearchParams(qs) } } as any;
}

/** The first findMany call is the user-table entries query — return arg. */
function entriesCallArg() {
  return dbMock.logEntry.findMany.mock.calls[0][0];
}

describe("GET /api/logs", () => {
  it("returns entries + health on a happy path", async () => {
    dbMock.logEntry.findMany.mockResolvedValueOnce([
      {
        id: "1",
        timestamp: new Date(),
        level: "error",
        component: "earnings",
        event: "fetch.error",
        meta: '{"foo":1}',
      },
    ]);
    const { GET } = await import("@/app/api/logs/route");
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].meta).toEqual({ foo: 1 });
    expect(body.health.length).toBeGreaterThan(0);
  });

  it("filters by level + component + clamps limit", async () => {
    const { GET } = await import("@/app/api/logs/route");
    await GET(makeRequest("level=warn&component=fetcher&limit=99999"));
    const args = entriesCallArg();
    expect(args.where.level).toBe("warn");
    expect(args.where.component).toBe("fetcher");
    expect(args.take).toBe(500); // MAX_LIMIT
  });

  it("uses default limit when not given", async () => {
    const { GET } = await import("@/app/api/logs/route");
    await GET(makeRequest());
    expect(entriesCallArg().take).toBe(100);
  });

  it("uses default limit when given garbage", async () => {
    const { GET } = await import("@/app/api/logs/route");
    await GET(makeRequest("limit=abc"));
    expect(entriesCallArg().take).toBe(100);
  });

  it("falls back gracefully for malformed meta JSON", async () => {
    dbMock.logEntry.findMany.mockResolvedValueOnce([
      {
        id: "1",
        timestamp: new Date(),
        level: "info",
        component: "x",
        event: "y",
        meta: "not-json",
      },
    ]);
    const { GET } = await import("@/app/api/logs/route");
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.entries[0].meta).toEqual({ _raw: "not-json" });
  });

  it("uses targeted indexed queries for health (no full-table scan)", async () => {
    // Regression: previously the health summary did
    //   findMany({ where: { timestamp: { gte: 14daysAgo } } })
    // which fetched 160k+ rows in production. The new implementation
    // runs findFirst calls scoped by (component, event) and small
    // findMany calls scoped by (component, level, timestamp).
    const { GET } = await import("@/app/api/logs/route");
    await GET(makeRequest());

    // findFirst is used for "last success" and "last start" — those
    // queries must never request a full window of rows.
    expect(dbMock.logEntry.findFirst).toHaveBeenCalled();
    const firstCallArgs = dbMock.logEntry.findFirst.mock.calls[0][0];
    expect(firstCallArgs.where.component).toBeTruthy();
    expect(firstCallArgs.where.event.in).toBeInstanceOf(Array);

    // Every findMany call for *recent issues* is bounded by `take` and by
    // a `where.timestamp.gte` cutoff. (The user-table query and the
    // distinct-components lookup have different shapes; filter them out.)
    const recentIssuesCalls = dbMock.logEntry.findMany.mock.calls.filter(
      ([args]: [any]) => args.where?.timestamp?.gte instanceof Date
    );
    expect(recentIssuesCalls.length).toBeGreaterThan(0);
    for (const [args] of recentIssuesCalls) {
      expect(args.take).toBeGreaterThan(0);
    }
  });

  it("returns the full distinct component list (not derived from entries)", async () => {
    dbMock.logEntry.findMany.mockImplementation(async (args: any) => {
      if (args.distinct?.includes("component")) {
        return [
          { component: "analysts" },
          { component: "api.logs" },
          { component: "fetcher" },
        ];
      }
      return [];
    });
    const { GET } = await import("@/app/api/logs/route");
    const res = await GET(makeRequest());
    const body = await res.json();
    expect(body.components).toEqual(["analysts", "api.logs", "fetcher"]);
  });

  it("returns 500 on DB error", async () => {
    dbMock.logEntry.findMany.mockRejectedValue(new Error("db down"));
    const { GET } = await import("@/app/api/logs/route");
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
  });
});
