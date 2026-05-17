import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `vi.hoisted` runs before any import statement, so the mock factories
// can safely reference these objects. Without this, static `import` of
// `@/lib/recommendation-log` (which imports db + logger) trips the
// hoist order and ReferenceErrors.
const { dbMock, loggerMock } = vi.hoisted(() => ({
  dbMock: {
    recommendationLog: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
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
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/logger", () => loggerMock);

import {
  getAuditTrail,
  hashRecommendationKey,
  maybeLogRecommendation,
  pruneOldRecommendations,
} from "@/lib/recommendation-log";
import { RECOMMENDATION_LOG_CONFIG } from "@/lib/config";
import type { Analysis } from "@/types";

function baseAnalysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    symbol: "TEST",
    price: 100,
    rsi: 50,
    sma20: 100,
    sma50: 100,
    bollingerUpper: 110,
    bollingerLower: 90,
    bollingerMid: 100,
    macdLine: 0,
    macdSignal: 0,
    macdHistogram: 0,
    dayChange: 0,
    weekChange: 0,
    monthChange: 0,
    avgDailyVolatility: 1,
    compositeScore: 30,
    recommendation: "BUY",
    signals: [],
    ...overrides,
  };
}

beforeEach(() => {
  dbMock.recommendationLog.findFirst = vi.fn().mockResolvedValue(null);
  dbMock.recommendationLog.findMany = vi.fn().mockResolvedValue([]);
  dbMock.recommendationLog.create = vi.fn().mockResolvedValue({});
  dbMock.recommendationLog.deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  loggerMock.log.warn = vi.fn();
  loggerMock.log.error = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("hashRecommendationKey", () => {
  it("is deterministic — same input → same hash", () => {
    const a = baseAnalysis();
    expect(hashRecommendationKey(a)).toBe(hashRecommendationKey(a));
  });

  it("differs when compositeScore changes", () => {
    const a = hashRecommendationKey(baseAnalysis({ compositeScore: 30 }));
    const b = hashRecommendationKey(baseAnalysis({ compositeScore: 50 }));
    expect(a).not.toBe(b);
  });

  it("differs when recommendation changes", () => {
    const a = hashRecommendationKey(baseAnalysis({ recommendation: "BUY" }));
    const b = hashRecommendationKey(baseAnalysis({ recommendation: "HOLD" }));
    expect(a).not.toBe(b);
  });

  it("differs when regime changes (and includes null vs set)", () => {
    const a = hashRecommendationKey(baseAnalysis());
    const b = hashRecommendationKey(
      baseAnalysis({
        regime: {
          regime: "trending_up",
          meanReversionMultiplier: 0.5,
          momentumMultiplier: 1.5,
          buyMultiplier: 1,
          sellMultiplier: 1,
        },
      })
    );
    expect(a).not.toBe(b);
  });

  it("differs when the present-catalyst set changes", () => {
    const a = hashRecommendationKey(
      baseAnalysis({
        catalysts: {
          score: 1,
          present: ["earnings_upcoming"],
          confidence: 1,
        },
      })
    );
    const b = hashRecommendationKey(
      baseAnalysis({
        catalysts: {
          score: 2,
          present: ["earnings_upcoming", "insider_cluster"],
          confidence: 2,
        },
      })
    );
    expect(a).not.toBe(b);
  });

  it("is invariant to catalyst-list ordering (set semantics)", () => {
    const a = hashRecommendationKey(
      baseAnalysis({
        catalysts: {
          score: 2,
          present: ["earnings_upcoming", "insider_cluster"],
          confidence: 2,
        },
      })
    );
    const b = hashRecommendationKey(
      baseAnalysis({
        catalysts: {
          score: 2,
          present: ["insider_cluster", "earnings_upcoming"],
          confidence: 2,
        },
      })
    );
    expect(a).toBe(b);
  });

  it("differs when qualityVeto.reason changes (and includes null vs set)", () => {
    const a = hashRecommendationKey(baseAnalysis());
    const b = hashRecommendationKey(
      baseAnalysis({
        qualityVeto: { reason: "no_earnings", detail: "ETF" },
      })
    );
    expect(a).not.toBe(b);
  });

  it("is unaffected by signal-weight noise (signals[] excluded)", () => {
    const a = hashRecommendationKey(
      baseAnalysis({
        signals: [{ label: "X", detail: "d", type: "buy", weight: 10 }],
      })
    );
    const b = hashRecommendationKey(
      baseAnalysis({
        signals: [
          { label: "X", detail: "d", type: "buy", weight: 10 },
          { label: "Y", detail: "d", type: "sell", weight: -5 },
        ],
      })
    );
    expect(a).toBe(b);
  });
});

describe("maybeLogRecommendation", () => {
  it("inserts a row on first observation for a symbol", async () => {
    dbMock.recommendationLog.findFirst.mockResolvedValue(null);
    const r = await maybeLogRecommendation("AAPL", baseAnalysis());
    expect(r).toEqual({ wrote: true, reason: "first-row" });
    expect(dbMock.recommendationLog.create).toHaveBeenCalledTimes(1);
    const data = dbMock.recommendationLog.create.mock.calls[0][0].data;
    expect(data.symbol).toBe("AAPL");
    expect(data.compositeScore).toBe(30);
    expect(data.recommendation).toBe("BUY");
    expect(typeof data.analysisHash).toBe("string");
    expect(data.signalBreakdown).toContain("compositeScore");
  });

  it("skips the write when the canonical hash matches the most recent row", async () => {
    const a = baseAnalysis();
    dbMock.recommendationLog.findFirst.mockResolvedValue({
      analysisHash: hashRecommendationKey(a),
    });
    const r = await maybeLogRecommendation("AAPL", a);
    expect(r).toEqual({ wrote: false, reason: "unchanged" });
    expect(dbMock.recommendationLog.create).not.toHaveBeenCalled();
  });

  it("writes a new row when the score moves", async () => {
    const prev = baseAnalysis({ compositeScore: 30 });
    const next = baseAnalysis({ compositeScore: 50 });
    dbMock.recommendationLog.findFirst.mockResolvedValue({
      analysisHash: hashRecommendationKey(prev),
    });
    const r = await maybeLogRecommendation("AAPL", next);
    expect(r).toEqual({ wrote: true, reason: "changed" });
    expect(dbMock.recommendationLog.create).toHaveBeenCalledTimes(1);
  });

  it("strips signals[] before persisting (UI-derived, recomputable)", async () => {
    const a = baseAnalysis({
      signals: [{ label: "X", detail: "d", type: "buy", weight: 10 }],
    });
    await maybeLogRecommendation("AAPL", a);
    const data = dbMock.recommendationLog.create.mock.calls[0][0].data;
    const parsed = JSON.parse(data.signalBreakdown);
    expect(parsed.signals).toBeUndefined();
    expect(parsed.compositeScore).toBe(30);
  });

  it("rounds compositeScore to an integer (DB column is Int)", async () => {
    const a = baseAnalysis({ compositeScore: 42.7 });
    await maybeLogRecommendation("AAPL", a);
    const data = dbMock.recommendationLog.create.mock.calls[0][0].data;
    expect(data.compositeScore).toBe(43);
  });

  it("returns { wrote: false, reason: error } and logs on DB failure (never throws)", async () => {
    dbMock.recommendationLog.create.mockRejectedValue(new Error("boom"));
    const r = await maybeLogRecommendation("AAPL", baseAnalysis());
    expect(r).toEqual({ wrote: false, reason: "error" });
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "audit-log",
      "write.failure",
      expect.any(Object)
    );
  });
});

describe("getAuditTrail", () => {
  it("returns rows mapped to the public shape, chronologically ascending", async () => {
    const t1 = new Date("2026-02-01T10:00:00Z");
    const t2 = new Date("2026-02-15T14:00:00Z");
    dbMock.recommendationLog.findMany.mockResolvedValue([
      {
        timestamp: t1,
        compositeScore: 30,
        recommendation: "BUY",
        regime: "trending_up",
        analysisHash: "abc",
        signalBreakdown: JSON.stringify({ symbol: "AAPL", compositeScore: 30 }),
      },
      {
        timestamp: t2,
        compositeScore: 50,
        recommendation: "STRONG BUY",
        regime: "trending_up",
        analysisHash: "def",
        signalBreakdown: JSON.stringify({ symbol: "AAPL", compositeScore: 50 }),
      },
    ]);

    const rows = await getAuditTrail("AAPL");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      timestamp: t1.toISOString(),
      compositeScore: 30,
      recommendation: "BUY",
      regime: "trending_up",
    });
    expect(rows[0].analysis).toMatchObject({ symbol: "AAPL", compositeScore: 30 });

    // Verify ordering option propagated.
    const where = dbMock.recommendationLog.findMany.mock.calls[0][0];
    expect(where.orderBy).toEqual({ timestamp: "asc" });
  });

  it("uses defaultReadWindowDays when no from is supplied", async () => {
    const before = Date.now();
    await getAuditTrail("AAPL");
    const where = dbMock.recommendationLog.findMany.mock.calls[0][0].where;
    const gte = (where.timestamp.gte as Date).getTime();
    const expected =
      before - RECOMMENDATION_LOG_CONFIG.defaultReadWindowDays * 86_400_000;
    // Allow a few ms of drift.
    expect(Math.abs(gte - expected)).toBeLessThan(1000);
  });

  it("respects explicit from/to options", async () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const to = new Date("2026-01-31T00:00:00Z");
    await getAuditTrail("AAPL", { from, to });
    const where = dbMock.recommendationLog.findMany.mock.calls[0][0].where;
    expect(where.timestamp.gte).toEqual(from);
    expect(where.timestamp.lte).toEqual(to);
  });

  it("accepts ISO-string dates as well as Date objects", async () => {
    await getAuditTrail("AAPL", {
      from: "2026-01-01",
      to: "2026-01-31",
    });
    const where = dbMock.recommendationLog.findMany.mock.calls[0][0].where;
    expect(where.timestamp.gte).toBeInstanceOf(Date);
    expect(where.timestamp.lte).toBeInstanceOf(Date);
  });

  it("caps the row limit at maxReadRows even when caller asks for more", async () => {
    await getAuditTrail("AAPL", { limit: 99999 });
    const args = dbMock.recommendationLog.findMany.mock.calls[0][0];
    expect(args.take).toBe(RECOMMENDATION_LOG_CONFIG.maxReadRows);
  });

  it("falls back to { _raw } when signalBreakdown is unparseable (forward-compat)", async () => {
    dbMock.recommendationLog.findMany.mockResolvedValue([
      {
        timestamp: new Date(),
        compositeScore: 30,
        recommendation: "BUY",
        regime: null,
        analysisHash: "x",
        signalBreakdown: "{ not json",
      },
    ]);
    const rows = await getAuditTrail("AAPL");
    expect(rows[0].analysis).toEqual({ _raw: "{ not json" });
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "audit-log",
      "read.parse-failure",
      expect.any(Object)
    );
  });
});

describe("pruneOldRecommendations", () => {
  it("deletes rows older than retentionDays and returns the count", async () => {
    dbMock.recommendationLog.deleteMany.mockResolvedValue({ count: 42 });
    const r = await pruneOldRecommendations();
    expect(r).toBe(42);
    const where = dbMock.recommendationLog.deleteMany.mock.calls[0][0].where;
    const cutoffMs = (where.timestamp.lt as Date).getTime();
    const expected =
      Date.now() - RECOMMENDATION_LOG_CONFIG.retentionDays * 86_400_000;
    expect(Math.abs(cutoffMs - expected)).toBeLessThan(1000);
  });

  it("returns 0 and logs on DB failure (never throws)", async () => {
    dbMock.recommendationLog.deleteMany.mockRejectedValue(new Error("nope"));
    expect(await pruneOldRecommendations()).toBe(0);
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "audit-log",
      "prune.failure",
      expect.any(Object)
    );
  });
});
