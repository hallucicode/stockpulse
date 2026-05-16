import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const dbMock: any = {
  sectorSnapshot: { create: vi.fn(), findFirst: vi.fn() },
};
vi.mock("@/lib/db", () => ({ db: dbMock }));

const marketMock: any = { getHistory: vi.fn() };
vi.mock("@/lib/market-data", () => marketMock);

const loggerMock: any = {
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
};
vi.mock("@/lib/logger", () => loggerMock);

function mkHistory(closes: number[]) {
  return closes.map((c, i) => ({
    date: new Date(2026, 0, i + 1).toISOString().slice(0, 10),
    open: c,
    high: c * 1.005,
    low: c * 0.995,
    close: c,
    volume: 1_000_000,
  }));
}

// Build a 250-bar series so SMA200 is well-defined: a long flat seed at
// 100, a brief sustained downtrend at 80, then a cross back up to 130
// short enough to fall inside the catalyst window. The exact classified
// state depends on default config; we use it to drive a happy-path persist.
function mkTurningUpHistory() {
  const closes: number[] = [];
  for (let i = 0; i < 200; i++) closes.push(100);
  for (let i = 0; i < 40; i++) closes.push(80);
  for (let i = 0; i < 10; i++) closes.push(130 + i);
  return mkHistory(closes);
}

// Mirror — sustained uptrend, then a fresh drop.
function mkTurningDownHistory() {
  const closes: number[] = [];
  for (let i = 0; i < 200; i++) closes.push(100);
  for (let i = 0; i < 40; i++) closes.push(120);
  for (let i = 0; i < 10; i++) closes.push(70 - i);
  return mkHistory(closes);
}

// Long ride above 200dma — should classify as trending_up.
function mkTrendingUpHistory() {
  const closes: number[] = [];
  for (let i = 0; i < 200; i++) closes.push(100);
  // Recent run length exceeds maxRecentUpBars (default 30).
  for (let i = 0; i < 60; i++) closes.push(130 + i * 0.1);
  return mkHistory(closes);
}

// Short up-bump with no prior downtrend → flat.
function mkFlatHistory() {
  const closes: number[] = [];
  for (let i = 0; i < 200; i++) closes.push(100);
  for (let i = 0; i < 3; i++) closes.push(110);
  return mkHistory(closes);
}

beforeEach(() => {
  vi.resetModules();
  dbMock.sectorSnapshot.create = vi.fn().mockResolvedValue({});
  dbMock.sectorSnapshot.findFirst = vi.fn().mockResolvedValue(null);
  marketMock.getHistory = vi.fn();
  loggerMock.log.info = vi.fn();
  loggerMock.log.warn = vi.fn();
  loggerMock.log.error = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("refreshSectorRotation", () => {
  it("classifies each configured sector ETF and persists one snapshot per success", async () => {
    marketMock.getHistory.mockResolvedValue(mkTurningUpHistory());
    const mod = await import("@/lib/sector-rotation-source");
    const succeeded = await mod.refreshSectorRotation();
    // The default SECTOR_ETF_MAP has many entries; every one should be
    // attempted and (with mocked history) succeed.
    expect(succeeded).toBeGreaterThan(0);
    expect(dbMock.sectorSnapshot.create).toHaveBeenCalledTimes(succeeded);
    // Verify shape of one persisted row.
    const firstCall = dbMock.sectorSnapshot.create.mock.calls[0][0];
    expect(firstCall.data).toMatchObject({
      sector: expect.any(String),
      etfSymbol: expect.any(String),
      state: expect.any(String),
      close: expect.any(Number),
      sma200: expect.any(Number),
    });
  });

  it("logs warn and skips persistence when an ETF has insufficient history", async () => {
    marketMock.getHistory.mockResolvedValue(mkHistory([100, 101, 102]));
    const mod = await import("@/lib/sector-rotation-source");
    const succeeded = await mod.refreshSectorRotation();
    expect(succeeded).toBe(0);
    expect(dbMock.sectorSnapshot.create).not.toHaveBeenCalled();
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "sector-rotation",
      "refresh.insufficient-data",
      expect.any(Object)
    );
  });

  it("persists turning_down with priorDownBars populated from the current run", async () => {
    marketMock.getHistory.mockResolvedValue(mkTurningDownHistory());
    const mod = await import("@/lib/sector-rotation-source");
    await mod.refreshSectorRotation();
    const persisted = dbMock.sectorSnapshot.create.mock.calls[0][0].data;
    expect(persisted.state).toBe("turning_down");
    // For a turning_down state, the *recent* run is below the SMA — the
    // schema stores that as priorDownBars (since recentUpBars is "the up
    // side", which here is the prior up trend before the drop).
    expect(persisted.priorDownBars).toBeGreaterThan(0);
    expect(persisted.recentUpBars).toBeGreaterThan(0);
  });

  it("persists trending_up with recentUpBars populated from the current run", async () => {
    marketMock.getHistory.mockResolvedValue(mkTrendingUpHistory());
    const mod = await import("@/lib/sector-rotation-source");
    await mod.refreshSectorRotation();
    const persisted = dbMock.sectorSnapshot.create.mock.calls[0][0].data;
    expect(persisted.state).toBe("trending_up");
    expect(persisted.recentUpBars).toBeGreaterThan(0);
    expect(persisted.priorDownBars).toBe(0);
  });

  it("persists flat with both run-length fields zeroed", async () => {
    marketMock.getHistory.mockResolvedValue(mkFlatHistory());
    const mod = await import("@/lib/sector-rotation-source");
    await mod.refreshSectorRotation();
    const persisted = dbMock.sectorSnapshot.create.mock.calls[0][0].data;
    expect(persisted.state).toBe("flat");
    expect(persisted.recentUpBars).toBe(0);
    expect(persisted.priorDownBars).toBe(0);
  });

  it("logs error and continues with the rest of the sectors when one ETF read fails", async () => {
    // First call rejects; subsequent calls succeed. Per-sector failure
    // must be non-fatal — partial success is the goal.
    let firstCalled = false;
    marketMock.getHistory.mockImplementation(async () => {
      if (!firstCalled) {
        firstCalled = true;
        throw new Error("Yahoo blip");
      }
      return mkTurningUpHistory();
    });
    const mod = await import("@/lib/sector-rotation-source");
    const succeeded = await mod.refreshSectorRotation();
    expect(succeeded).toBeGreaterThan(0);
    expect(loggerMock.log.error).toHaveBeenCalledWith(
      "sector-rotation",
      "refresh.error",
      expect.any(Object)
    );
  });
});

describe("getCurrentSectorRotationMap", () => {
  it("returns an empty map on cold start (no snapshots persisted yet)", async () => {
    dbMock.sectorSnapshot.findFirst.mockResolvedValue(null);
    const mod = await import("@/lib/sector-rotation-source");
    const map = await mod.getCurrentSectorRotationMap();
    expect(map.size).toBe(0);
  });

  it("returns the latest snapshot per sector", async () => {
    dbMock.sectorSnapshot.findFirst.mockImplementation(
      async ({ where }: { where: { sector: string } }) => {
        // Only return a row for Tech; other sectors return null.
        if (where.sector === "Tech") {
          return {
            sector: "Tech",
            etfSymbol: "XLK",
            state: "turning_up",
            close: 200,
            sma200: 190,
            recentUpBars: 4,
            priorDownBars: 30,
            fetchedAt: new Date(),
          };
        }
        return null;
      }
    );
    const mod = await import("@/lib/sector-rotation-source");
    const map = await mod.getCurrentSectorRotationMap();
    expect(map.get("Tech")).toMatchObject({
      state: "turning_up",
      etfSymbol: "XLK",
      close: 200,
      sma200: 190,
      recentRunBars: 4,
    });
    expect(map.has("Healthcare")).toBe(false);
  });

  it("uses max(up,down) for the run length when the state is flat", async () => {
    dbMock.sectorSnapshot.findFirst.mockImplementation(
      async ({ where }: { where: { sector: string } }) => {
        if (where.sector === "Materials") {
          return {
            sector: "Materials",
            etfSymbol: "XLB",
            state: "flat",
            close: 100,
            sma200: 99,
            recentUpBars: 2,
            priorDownBars: 5,
            fetchedAt: new Date(),
          };
        }
        return null;
      }
    );
    const mod = await import("@/lib/sector-rotation-source");
    const map = await mod.getCurrentSectorRotationMap();
    expect(map.get("Materials")?.recentRunBars).toBe(5);
  });

  it("uses priorDownBars for the run length when the state is trending_down", async () => {
    dbMock.sectorSnapshot.findFirst.mockImplementation(
      async ({ where }: { where: { sector: string } }) => {
        if (where.sector === "Energy") {
          return {
            sector: "Energy",
            etfSymbol: "XLE",
            state: "trending_down",
            close: 80,
            sma200: 100,
            recentUpBars: 0,
            priorDownBars: 60,
            fetchedAt: new Date(),
          };
        }
        return null;
      }
    );
    const mod = await import("@/lib/sector-rotation-source");
    const map = await mod.getCurrentSectorRotationMap();
    expect(map.get("Energy")?.recentRunBars).toBe(60);
  });
});
