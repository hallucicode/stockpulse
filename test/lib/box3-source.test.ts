import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { dbMock, loggerMock, fxSourceMock } = vi.hoisted(() => ({
  dbMock: {
    analysisCache: { findUnique: vi.fn() },
    position: { findMany: vi.fn() },
    box3Snapshot: { create: vi.fn(), findMany: vi.fn() },
  },
  loggerMock: {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
  fxSourceMock: {
    getLatestUsdEurRate: vi.fn(),
  },
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/logger", () => loggerMock);
vi.mock("@/lib/fx-source", () => fxSourceMock);

import {
  computeCurrentValuation,
  listSnapshots,
  takeSnapshot,
} from "@/lib/box3-source";

beforeEach(() => {
  dbMock.analysisCache.findUnique = vi.fn().mockResolvedValue(null);
  dbMock.position.findMany = vi.fn().mockResolvedValue([]);
  dbMock.box3Snapshot.create = vi.fn().mockImplementation(async (args) => ({
    id: "snap1",
    ...args.data,
    createdAt: new Date(),
  }));
  dbMock.box3Snapshot.findMany = vi.fn().mockResolvedValue([]);
  fxSourceMock.getLatestUsdEurRate = vi.fn().mockResolvedValue(null);
  loggerMock.log.info = vi.fn();
  loggerMock.log.warn = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeCurrentValuation", () => {
  it("returns no-fx-rate when the FX cache is cold", async () => {
    const r = await computeCurrentValuation();
    expect(r).toEqual({ kind: "no-fx-rate", lastFxRateDate: null });
  });

  it("returns a full valuation when FX rate + positions + prices are present", async () => {
    fxSourceMock.getLatestUsdEurRate.mockResolvedValue({
      rate: 0.92,
      date: new Date("2026-05-16T00:00:00Z"),
    });
    dbMock.position.findMany.mockResolvedValue([
      { symbol: "AAPL", shares: 10, buyPrice: 150 },
      { symbol: "MSFT", shares: 5, buyPrice: 380 },
    ]);
    dbMock.analysisCache.findUnique.mockImplementation(async ({ where }) => ({
      data: JSON.stringify({
        analysis: { price: where.symbol === "AAPL" ? 180 : 400 },
      }),
    }));

    const r = await computeCurrentValuation();
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.valuation.totalValueUsd).toBe(1800 + 2000);
      expect(r.valuation.fallbackCount).toBe(0);
      expect(r.estimate.totalValueEur).toBe(r.valuation.totalValueEur);
      expect(r.asOf).toEqual(new Date("2026-05-16T00:00:00Z"));
    }
  });

  it("falls back to buyPrice when analysis cache row is missing", async () => {
    fxSourceMock.getLatestUsdEurRate.mockResolvedValue({
      rate: 0.92,
      date: new Date(),
    });
    dbMock.position.findMany.mockResolvedValue([
      { symbol: "STALE", shares: 10, buyPrice: 50 },
    ]);
    dbMock.analysisCache.findUnique.mockResolvedValue(null);

    const r = await computeCurrentValuation();
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.valuation.positions[0].usedFallbackPrice).toBe(true);
      expect(r.valuation.positions[0].effectivePriceUsd).toBe(50);
      expect(r.valuation.fallbackCount).toBe(1);
    }
  });

  it("falls back to buyPrice when AnalysisCache JSON is malformed", async () => {
    fxSourceMock.getLatestUsdEurRate.mockResolvedValue({
      rate: 0.92,
      date: new Date(),
    });
    dbMock.position.findMany.mockResolvedValue([
      { symbol: "BAD", shares: 10, buyPrice: 50 },
    ]);
    dbMock.analysisCache.findUnique.mockResolvedValue({ data: "{ not json" });

    const r = await computeCurrentValuation();
    if (r.kind === "ok") {
      expect(r.valuation.positions[0].usedFallbackPrice).toBe(true);
    }
  });

  it("falls back to buyPrice when JSON has no analysis.price", async () => {
    fxSourceMock.getLatestUsdEurRate.mockResolvedValue({
      rate: 0.92,
      date: new Date(),
    });
    dbMock.position.findMany.mockResolvedValue([
      { symbol: "NOPRICE", shares: 10, buyPrice: 50 },
    ]);
    dbMock.analysisCache.findUnique.mockResolvedValue({
      data: JSON.stringify({ analysis: {} }),
    });

    const r = await computeCurrentValuation();
    if (r.kind === "ok") {
      expect(r.valuation.positions[0].usedFallbackPrice).toBe(true);
    }
  });

  it("only queries open positions (filters out closed)", async () => {
    fxSourceMock.getLatestUsdEurRate.mockResolvedValue({
      rate: 0.92,
      date: new Date(),
    });
    await computeCurrentValuation();
    const args = dbMock.position.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ status: "open" });
  });

  it("returns an empty-portfolio valuation for an empty positions table", async () => {
    fxSourceMock.getLatestUsdEurRate.mockResolvedValue({
      rate: 0.92,
      date: new Date(),
    });
    dbMock.position.findMany.mockResolvedValue([]);
    const r = await computeCurrentValuation();
    if (r.kind === "ok") {
      expect(r.valuation.totalValueUsd).toBe(0);
      expect(r.valuation.totalValueEur).toBe(0);
      expect(r.valuation.positions).toEqual([]);
      expect(r.estimate.estimatedTaxEur).toBe(0);
    }
  });
});

describe("takeSnapshot", () => {
  it("persists a row with the current valuation + tax year + label", async () => {
    fxSourceMock.getLatestUsdEurRate.mockResolvedValue({
      rate: 0.92,
      date: new Date(),
    });
    dbMock.position.findMany.mockResolvedValue([
      { symbol: "AAPL", shares: 10, buyPrice: 150 },
    ]);
    dbMock.analysisCache.findUnique.mockResolvedValue({
      data: JSON.stringify({ analysis: { price: 180 } }),
    });

    const r = await takeSnapshot({ label: "Jan 1 2026" });
    expect(r.id).toBe("snap1");
    expect(dbMock.box3Snapshot.create).toHaveBeenCalledTimes(1);
    const data = dbMock.box3Snapshot.create.mock.calls[0][0].data;
    expect(data.label).toBe("Jan 1 2026");
    expect(data.taxYear).toBeGreaterThanOrEqual(2026);
    expect(data.totalValueUsd).toBe(1800);
    expect(typeof data.perPositionJson).toBe("string");
    expect(JSON.parse(data.perPositionJson)[0].symbol).toBe("AAPL");
  });

  it("uses provided effectiveDate when supplied", async () => {
    fxSourceMock.getLatestUsdEurRate.mockResolvedValue({
      rate: 0.92,
      date: new Date(),
    });
    const peildatum = new Date("2026-01-01T00:00:00Z");
    await takeSnapshot({ effectiveDate: peildatum });
    const data = dbMock.box3Snapshot.create.mock.calls[0][0].data;
    expect(data.date).toEqual(peildatum);
  });

  it("defaults label to empty string when not supplied", async () => {
    fxSourceMock.getLatestUsdEurRate.mockResolvedValue({
      rate: 0.92,
      date: new Date(),
    });
    await takeSnapshot();
    const data = dbMock.box3Snapshot.create.mock.calls[0][0].data;
    expect(data.label).toBe("");
  });

  it("throws when no FX rate is available (caller surfaces as 5xx)", async () => {
    fxSourceMock.getLatestUsdEurRate.mockResolvedValue(null);
    await expect(takeSnapshot()).rejects.toThrow(/FX rate/);
    expect(dbMock.box3Snapshot.create).not.toHaveBeenCalled();
  });

  it("logs a box3:snapshot.taken event on success", async () => {
    fxSourceMock.getLatestUsdEurRate.mockResolvedValue({
      rate: 0.92,
      date: new Date(),
    });
    await takeSnapshot();
    expect(loggerMock.log.info).toHaveBeenCalledWith(
      "box3",
      "snapshot.taken",
      expect.any(Object)
    );
  });
});

describe("listSnapshots", () => {
  it("returns an empty array when no snapshots exist", async () => {
    dbMock.box3Snapshot.findMany.mockResolvedValue([]);
    expect(await listSnapshots()).toEqual([]);
  });

  it("maps rows to the public shape (date/createdAt as ISO)", async () => {
    const t1 = new Date("2026-01-01T00:00:00Z");
    const t2 = new Date("2026-05-01T00:00:00Z");
    dbMock.box3Snapshot.findMany.mockResolvedValue([
      {
        id: "s2",
        date: t2,
        taxYear: 2026,
        label: "End of April",
        totalValueUsd: 200_000,
        totalValueEur: 184_000,
        usdEurRate: 0.92,
        createdAt: t2,
      },
      {
        id: "s1",
        date: t1,
        taxYear: 2026,
        label: "Jan 1",
        totalValueUsd: 150_000,
        totalValueEur: 138_000,
        usdEurRate: 0.92,
        createdAt: t1,
      },
    ]);
    const r = await listSnapshots();
    expect(r).toHaveLength(2);
    expect(r[0].date).toBe(t2.toISOString());
    expect(r[0].label).toBe("End of April");
    expect(r[1].id).toBe("s1");
  });

  it("queries with date-desc + createdAt-desc ordering (latest first)", async () => {
    await listSnapshots();
    const args = dbMock.box3Snapshot.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([
      { date: "desc" },
      { createdAt: "desc" },
    ]);
  });
});
