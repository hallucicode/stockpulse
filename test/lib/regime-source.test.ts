import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const dbMock: any = {
  regimeSnapshot: {
    create: vi.fn(),
    findFirst: vi.fn(),
  },
};
vi.mock("@/lib/db", () => ({ db: dbMock }));

const marketMock: any = { getHistory: vi.fn() };
vi.mock("@/lib/market-data", () => marketMock);

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

beforeEach(() => {
  vi.resetModules();
  dbMock.regimeSnapshot.create = vi.fn().mockResolvedValue({});
  dbMock.regimeSnapshot.findFirst = vi.fn().mockResolvedValue(null);
  marketMock.getHistory = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("refreshRegimeSnapshot", () => {
  it("returns null when SPY data is insufficient", async () => {
    marketMock.getHistory.mockResolvedValue(mkHistory([100, 101]));
    const mod = await import("@/lib/regime-source");
    const r = await mod.refreshRegimeSnapshot();
    expect(r).toBeNull();
    expect(dbMock.regimeSnapshot.create).not.toHaveBeenCalled();
  });

  it("persists a snapshot and returns the regime on healthy data", async () => {
    // SPY trending up: monotonically rising 300 bars
    const spy = mkHistory(Array.from({ length: 300 }, (_, i) => 100 + i));
    // VIX low and stable
    const vix = mkHistory(Array.from({ length: 252 }, () => 15));
    marketMock.getHistory.mockImplementation(async (sym: string) => {
      if (sym === "SPY") return spy;
      return vix;
    });
    const mod = await import("@/lib/regime-source");
    const r = await mod.refreshRegimeSnapshot();
    expect(r).toBe("trending_up");
    expect(dbMock.regimeSnapshot.create).toHaveBeenCalledTimes(1);
    const data = dbMock.regimeSnapshot.create.mock.calls[0][0].data;
    expect(data.regime).toBe("trending_up");
    expect(data.spyClose).toBeGreaterThan(0);
    expect(data.spy200dma).toBeGreaterThan(0);
  });

  it("returns null and logs on fetch error", async () => {
    marketMock.getHistory.mockRejectedValue(new Error("net"));
    const mod = await import("@/lib/regime-source");
    const r = await mod.refreshRegimeSnapshot();
    expect(r).toBeNull();
  });

  it("classifies crisis when VIX is elevated", async () => {
    const spy = mkHistory(Array.from({ length: 300 }, (_, i) => 100 + i));
    const vixBase = Array.from({ length: 251 }, () => 14);
    const vix = mkHistory([...vixBase, 40]); // crisis-level last reading
    marketMock.getHistory.mockImplementation(async (sym: string) => {
      if (sym === "SPY") return spy;
      return vix;
    });
    const mod = await import("@/lib/regime-source");
    const r = await mod.refreshRegimeSnapshot();
    expect(r).toBe("high_vol_crisis");
  });
});

describe("getCurrentRegime", () => {
  it("returns null when no snapshot exists", async () => {
    dbMock.regimeSnapshot.findFirst.mockResolvedValue(null);
    const mod = await import("@/lib/regime-source");
    expect(await mod.getCurrentRegime()).toBeNull();
  });

  it("returns the regime from the latest snapshot", async () => {
    dbMock.regimeSnapshot.findFirst.mockResolvedValue({
      regime: "ranging",
      fetchedAt: new Date(),
    });
    const mod = await import("@/lib/regime-source");
    expect(await mod.getCurrentRegime()).toBe("ranging");
  });
});
