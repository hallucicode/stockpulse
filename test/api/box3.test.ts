import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { box3SourceMock, loggerMock } = vi.hoisted(() => ({
  box3SourceMock: {
    computeCurrentValuation: vi.fn(),
    takeSnapshot: vi.fn(),
    listSnapshots: vi.fn(),
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
vi.mock("@/lib/box3-source", () => box3SourceMock);
vi.mock("@/lib/logger", () => loggerMock);

import { GET as getEstimate } from "@/app/api/box3/estimate/route";
import { POST as postSnapshot } from "@/app/api/box3/snapshot/route";
import { GET as listSnapshotsRoute } from "@/app/api/box3/snapshots/route";

function makePostRequest(body: unknown): unknown {
  return {
    json: async () => body,
  };
}

beforeEach(() => {
  box3SourceMock.computeCurrentValuation = vi.fn();
  box3SourceMock.takeSnapshot = vi.fn();
  box3SourceMock.listSnapshots = vi.fn();
  loggerMock.log.error = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/box3/estimate", () => {
  it("returns the full valuation when FX rate is available", async () => {
    box3SourceMock.computeCurrentValuation.mockResolvedValue({
      kind: "ok",
      valuation: {
        usdEurRate: 0.92,
        totalValueUsd: 3800,
        totalValueEur: 3496,
        fallbackCount: 0,
        positions: [
          {
            symbol: "AAPL",
            shares: 10,
            effectivePriceUsd: 180,
            valueUsd: 1800,
            valueEur: 1656,
            usedFallbackPrice: false,
          },
        ],
      },
      estimate: {
        totalValueEur: 3496,
        heffingsvrijVermogen: 57000,
        taxableBaseEur: 0,
        deemedReturnRate: 0.0604,
        deemedReturnEur: 0,
        taxRate: 0.36,
        estimatedTaxEur: 0,
        taxYear: 2026,
      },
      asOf: new Date("2026-05-16T00:00:00Z"),
      fxStale: false,
    });

    const res = await getEstimate();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.kind).toBe("ok");
    expect(body.valuation.totalValueUsd).toBe(3800);
    expect(body.estimate.taxYear).toBe(2026);
    expect(body.asOf).toBe("2026-05-16T00:00:00.000Z");
  });

  it("returns kind=no-fx-rate when FX cache is empty", async () => {
    box3SourceMock.computeCurrentValuation.mockResolvedValue({
      kind: "no-fx-rate",
      lastFxRateDate: null,
    });
    const res = await getEstimate();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.kind).toBe("no-fx-rate");
  });

  it("returns 500 when the source layer throws", async () => {
    box3SourceMock.computeCurrentValuation.mockRejectedValue(
      new Error("db down")
    );
    const res = await getEstimate();
    expect(res.status).toBe(500);
    expect(loggerMock.log.error).toHaveBeenCalledWith(
      "api.box3",
      "estimate.error",
      expect.any(Object)
    );
  });
});

describe("POST /api/box3/snapshot", () => {
  it("persists with the provided label and returns 200 + snapshot data", async () => {
    box3SourceMock.takeSnapshot.mockResolvedValue({
      id: "snap-1",
      valuation: {
        kind: "ok",
        valuation: {
          usdEurRate: 0.92,
          totalValueUsd: 3800,
          totalValueEur: 3496,
          fallbackCount: 0,
          positions: [],
        },
        estimate: {
          totalValueEur: 3496,
          heffingsvrijVermogen: 57000,
          taxableBaseEur: 0,
          deemedReturnRate: 0.0604,
          deemedReturnEur: 0,
          taxRate: 0.36,
          estimatedTaxEur: 0,
          taxYear: 2026,
        },
        asOf: new Date("2026-05-16T00:00:00Z"),
        fxStale: false,
      },
    });

    const res = await postSnapshot(
      makePostRequest({ label: "Jan 1 2026" }) as never
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.id).toBe("snap-1");
    expect(body.totalValueUsd).toBe(3800);
    expect(box3SourceMock.takeSnapshot).toHaveBeenCalledWith({
      label: "Jan 1 2026",
      effectiveDate: undefined,
    });
  });

  it("parses effectiveDate when provided", async () => {
    box3SourceMock.takeSnapshot.mockResolvedValue({
      id: "snap-2",
      valuation: {
        kind: "ok",
        valuation: {
          usdEurRate: 0.92,
          totalValueUsd: 0,
          totalValueEur: 0,
          fallbackCount: 0,
          positions: [],
        },
        estimate: {
          totalValueEur: 0,
          heffingsvrijVermogen: 57000,
          taxableBaseEur: 0,
          deemedReturnRate: 0.0604,
          deemedReturnEur: 0,
          taxRate: 0.36,
          estimatedTaxEur: 0,
          taxYear: 2026,
        },
        asOf: new Date(),
        fxStale: false,
      },
    });

    await postSnapshot(
      makePostRequest({
        label: "Peildatum",
        effectiveDate: "2026-01-01T00:00:00Z",
      }) as never
    );
    const opts = box3SourceMock.takeSnapshot.mock.calls[0][0];
    expect(opts.effectiveDate).toEqual(new Date("2026-01-01T00:00:00Z"));
  });

  it("returns 400 on malformed effectiveDate", async () => {
    const res = await postSnapshot(
      makePostRequest({ effectiveDate: "not-a-date" }) as never
    );
    expect(res.status).toBe(400);
    expect(box3SourceMock.takeSnapshot).not.toHaveBeenCalled();
  });

  it("accepts an empty body (defaults to today + no label)", async () => {
    box3SourceMock.takeSnapshot.mockResolvedValue({
      id: "snap-3",
      valuation: {
        kind: "ok",
        valuation: {
          usdEurRate: 0.92,
          totalValueUsd: 0,
          totalValueEur: 0,
          fallbackCount: 0,
          positions: [],
        },
        estimate: {
          totalValueEur: 0,
          heffingsvrijVermogen: 57000,
          taxableBaseEur: 0,
          deemedReturnRate: 0.0604,
          deemedReturnEur: 0,
          taxRate: 0.36,
          estimatedTaxEur: 0,
          taxYear: 2026,
        },
        asOf: new Date(),
        fxStale: false,
      },
    });
    const res = await postSnapshot({ json: async () => ({}) } as never);
    expect(res.status).toBe(200);
  });

  it("tolerates an unparseable JSON body (defaults applied)", async () => {
    box3SourceMock.takeSnapshot.mockResolvedValue({
      id: "snap-4",
      valuation: {
        kind: "ok",
        valuation: {
          usdEurRate: 0.92,
          totalValueUsd: 0,
          totalValueEur: 0,
          fallbackCount: 0,
          positions: [],
        },
        estimate: {
          totalValueEur: 0,
          heffingsvrijVermogen: 57000,
          taxableBaseEur: 0,
          deemedReturnRate: 0.0604,
          deemedReturnEur: 0,
          taxRate: 0.36,
          estimatedTaxEur: 0,
          taxYear: 2026,
        },
        asOf: new Date(),
        fxStale: false,
      },
    });
    const res = await postSnapshot({
      json: async () => {
        throw new Error("bad json");
      },
    } as never);
    expect(res.status).toBe(200);
  });

  it("returns 503 when FX rate is unavailable (degraded service)", async () => {
    box3SourceMock.takeSnapshot.mockRejectedValue(
      new Error(
        "Cannot snapshot without an FX rate — wait for the fx.refresh cron to populate one."
      )
    );
    const res = await postSnapshot({ json: async () => ({}) } as never);
    expect(res.status).toBe(503);
  });

  it("returns 500 on any other failure", async () => {
    box3SourceMock.takeSnapshot.mockRejectedValue(new Error("db down"));
    const res = await postSnapshot({ json: async () => ({}) } as never);
    expect(res.status).toBe(500);
    expect(loggerMock.log.error).toHaveBeenCalledWith(
      "api.box3",
      "snapshot.error",
      expect.any(Object)
    );
  });
});

describe("GET /api/box3/snapshots", () => {
  it("returns the list with count", async () => {
    box3SourceMock.listSnapshots.mockResolvedValue([
      {
        id: "s1",
        date: "2026-01-01T00:00:00Z",
        taxYear: 2026,
        label: "Jan 1",
        totalValueUsd: 100_000,
        totalValueEur: 92_000,
        usdEurRate: 0.92,
        createdAt: "2026-01-01T12:00:00Z",
      },
    ]);
    const res = await listSnapshotsRoute();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.snapshots[0].id).toBe("s1");
  });

  it("returns empty array + count=0 when no snapshots exist", async () => {
    box3SourceMock.listSnapshots.mockResolvedValue([]);
    const res = await listSnapshotsRoute();
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.snapshots).toEqual([]);
  });

  it("returns 500 on source failure", async () => {
    box3SourceMock.listSnapshots.mockRejectedValue(new Error("db down"));
    const res = await listSnapshotsRoute();
    expect(res.status).toBe(500);
    expect(loggerMock.log.error).toHaveBeenCalledWith(
      "api.box3",
      "snapshots.error",
      expect.any(Object)
    );
  });
});
