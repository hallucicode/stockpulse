import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", async () => {
  const real: any = await vi.importActual("@/lib/config");
  return {
    ...real,
    ANALYSTS_CONFIG: {
      ...real.ANALYSTS_CONFIG,
      requestSpacingMs: 0,
      rateLimitBackoffMs: 0,
    },
  };
});

const yfMock: any = {
  quoteSummary: vi.fn(),
};
vi.mock("yahoo-finance2", () => ({
  default: function () {
    return yfMock;
  },
}));

const dbMock: any = {
  watchlistStock: { findMany: vi.fn() },
  analystAction: {
    upsert: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
  },
};
vi.mock("@/lib/db", () => ({ db: dbMock }));

beforeEach(() => {
  vi.resetModules();
  yfMock.quoteSummary = vi.fn();
  dbMock.watchlistStock.findMany = vi.fn().mockResolvedValue([]);
  dbMock.analystAction.upsert = vi.fn().mockResolvedValue({});
  dbMock.analystAction.deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  dbMock.analystAction.findMany = vi.fn().mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("refreshAllAnalysts", () => {
  it("fetches via yahoo-finance2 and persists rows for each symbol", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAPL" },
      { symbol: "MSFT" },
    ]);
    yfMock.quoteSummary.mockResolvedValue({
      upgradeDowngradeHistory: {
        history: [
          {
            epochGradeDate: new Date("2026-04-12"),
            firm: "Goldman Sachs",
            fromGrade: "Hold",
            toGrade: "Buy",
            action: "up",
          },
        ],
      },
    });

    const mod = await import("@/lib/analysts-source");
    const r = await mod.refreshAllAnalysts();
    expect(r.succeeded).toBe(2);
    expect(yfMock.quoteSummary).toHaveBeenCalledTimes(2);
    expect(dbMock.analystAction.upsert).toHaveBeenCalledTimes(2);
  });

  it("treats yahoo errors as errored (no rate-limit / forbidden special cases)", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "X" },
      { symbol: "Y" },
    ]);
    let call = 0;
    yfMock.quoteSummary.mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error("yahoo blip");
      return { upgradeDowngradeHistory: { history: [] } };
    });
    const mod = await import("@/lib/analysts-source");
    const r = await mod.refreshAllAnalysts();
    expect(r.errored).toBe(1);
    expect(r.succeeded).toBe(1);
  });

  it("handles symbols with no upgradeDowngradeHistory data", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([{ symbol: "OBSCURE" }]);
    yfMock.quoteSummary.mockResolvedValue({}); // no upgradeDowngradeHistory
    const mod = await import("@/lib/analysts-source");
    const r = await mod.refreshAllAnalysts();
    expect(r.succeeded).toBe(1);
    expect(dbMock.analystAction.upsert).not.toHaveBeenCalled();
  });

  it("ignores rows missing required fields", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([{ symbol: "X" }]);
    yfMock.quoteSummary.mockResolvedValue({
      upgradeDowngradeHistory: {
        history: [
          { firm: "GS" }, // missing action, date
          { action: "up", epochGradeDate: new Date() }, // missing firm
          {
            firm: "GS",
            action: "up",
            epochGradeDate: new Date("2026-04-10"),
          }, // ok
        ],
      },
    });
    const mod = await import("@/lib/analysts-source");
    await mod.refreshAllAnalysts();
    expect(dbMock.analystAction.upsert).toHaveBeenCalledTimes(1);
  });

  it("normalises unix-second timestamps", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([{ symbol: "X" }]);
    const epoch = 1714000000; // April 2024 in unix seconds
    yfMock.quoteSummary.mockResolvedValue({
      upgradeDowngradeHistory: {
        history: [
          { firm: "GS", action: "up", epochGradeDate: epoch },
        ],
      },
    });
    const mod = await import("@/lib/analysts-source");
    await mod.refreshAllAnalysts();
    const args = dbMock.analystAction.upsert.mock.calls[0][0];
    expect(args.create.publishedAt.getFullYear()).toBe(2024);
  });

  it("makes calls strictly serially", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue(
      [..."ABC"].map((c) => ({ symbol: `S${c}` }))
    );
    let inFlight = 0;
    let max = 0;
    yfMock.quoteSummary.mockImplementation(async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { upgradeDowngradeHistory: { history: [] } };
    });
    const mod = await import("@/lib/analysts-source");
    await mod.refreshAllAnalysts();
    expect(max).toBe(1);
  });
});

describe("getRecentAnalystActionsForSymbol", () => {
  it("maps DB rows to AnalystEvent shape", async () => {
    dbMock.analystAction.findMany.mockResolvedValue([
      {
        firm: "GS",
        fromGrade: "Hold",
        toGrade: "Buy",
        action: "up",
        publishedAt: new Date(),
      },
    ]);
    const mod = await import("@/lib/analysts-source");
    const out = await mod.getRecentAnalystActionsForSymbol("X");
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe("up");
  });
});
