import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { recLogMock, loggerMock } = vi.hoisted(() => ({
  recLogMock: {
    getAuditTrail: vi.fn(),
  },
  loggerMock: {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));
vi.mock("@/lib/recommendation-log", () => recLogMock);
vi.mock("@/lib/logger", () => loggerMock);

import { GET } from "@/app/api/audit/[symbol]/route";

function makeRequest(qs = "") {
  return {
    nextUrl: {
      searchParams: new URLSearchParams(qs),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  recLogMock.getAuditTrail = vi.fn().mockResolvedValue([]);
  loggerMock.log.error = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/audit/[symbol]", () => {
  it("returns 400 for an empty or malformed symbol", async () => {
    const r1 = await GET(makeRequest(), { params: { symbol: "" } });
    expect(r1.status).toBe(400);
    const r2 = await GET(makeRequest(), { params: { symbol: "AAPL!" } });
    expect(r2.status).toBe(400);
    expect(recLogMock.getAuditTrail).not.toHaveBeenCalled();
  });

  it("uppercases the symbol before lookup", async () => {
    await GET(makeRequest(), { params: { symbol: "aapl" } });
    expect(recLogMock.getAuditTrail).toHaveBeenCalledWith("AAPL", expect.any(Object));
  });

  it("returns rows + count for a known symbol", async () => {
    recLogMock.getAuditTrail.mockResolvedValue([
      {
        timestamp: "2026-02-01T10:00:00Z",
        compositeScore: 30,
        recommendation: "BUY",
        regime: "trending_up",
        analysisHash: "abc",
        analysis: { compositeScore: 30 },
      },
      {
        timestamp: "2026-02-15T14:00:00Z",
        compositeScore: 50,
        recommendation: "STRONG BUY",
        regime: "trending_up",
        analysisHash: "def",
        analysis: { compositeScore: 50 },
      },
    ]);

    const res = await GET(makeRequest(), { params: { symbol: "AAPL" } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.symbol).toBe("AAPL");
    expect(body.count).toBe(2);
    expect(body.rows[0].recommendation).toBe("BUY");
    expect(body.rows[1].recommendation).toBe("STRONG BUY");
  });

  it("returns empty rows + count=0 for a known-but-no-history symbol", async () => {
    recLogMock.getAuditTrail.mockResolvedValue([]);
    const res = await GET(makeRequest(), { params: { symbol: "QUIET" } });
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.rows).toEqual([]);
  });

  it("forwards from/to/limit query params to getAuditTrail", async () => {
    await GET(
      makeRequest("from=2026-01-01&to=2026-02-01&limit=100"),
      { params: { symbol: "AAPL" } }
    );
    const opts = recLogMock.getAuditTrail.mock.calls[0][1];
    expect(opts.from).toBeInstanceOf(Date);
    expect(opts.to).toBeInstanceOf(Date);
    expect(opts.limit).toBe(100);
  });

  it("returns 400 on malformed `from` date (rather than silent fallback)", async () => {
    const res = await GET(
      makeRequest("from=not-a-date"),
      { params: { symbol: "AAPL" } }
    );
    expect(res.status).toBe(400);
    expect(recLogMock.getAuditTrail).not.toHaveBeenCalled();
  });

  it("returns 400 on malformed `to` date", async () => {
    const res = await GET(
      makeRequest("to=garbage"),
      { params: { symbol: "AAPL" } }
    );
    expect(res.status).toBe(400);
  });

  it("treats a non-positive `limit` as undefined (default cap applies)", async () => {
    await GET(
      makeRequest("limit=-5"),
      { params: { symbol: "AAPL" } }
    );
    const opts = recLogMock.getAuditTrail.mock.calls[0][1];
    expect(opts.limit).toBeUndefined();
  });

  it("returns 500 when getAuditTrail throws", async () => {
    recLogMock.getAuditTrail.mockRejectedValue(new Error("db down"));
    const res = await GET(makeRequest(), { params: { symbol: "AAPL" } });
    expect(res.status).toBe(500);
    expect(loggerMock.log.error).toHaveBeenCalledWith(
      "api.audit",
      "fetch.error",
      expect.any(Object)
    );
  });
});
