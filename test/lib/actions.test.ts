import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMock: any = {
  watchlistStock: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  alert: {
    deleteMany: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
  },
  position: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
};

vi.mock("@/lib/db", () => ({ db: dbMock }));

const marketMock: any = {
  getQuote: vi.fn(),
  getQuotes: vi.fn(),
  getHistory: vi.fn(),
};

vi.mock("@/lib/market-data", () => marketMock);

const analysisMock: any = {
  analyzeStock: vi.fn(),
  getSellSignal: vi.fn(),
};

vi.mock("@/lib/analysis", () => analysisMock);

beforeEach(() => {
  // Reassign fresh mocks each test
  for (const m of [
    dbMock.watchlistStock,
    dbMock.alert,
    dbMock.position,
  ]) {
    for (const k of Object.keys(m)) m[k] = vi.fn();
  }
  marketMock.getQuote = vi.fn();
  marketMock.getQuotes = vi.fn();
  marketMock.getHistory = vi.fn();
  analysisMock.analyzeStock = vi.fn();
  analysisMock.getSellSignal = vi.fn();
});

describe("actions", () => {
  it("getWatchlist queries db", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([{ symbol: "A" }]);
    const { getWatchlist } = await import("@/lib/actions");
    const r = await getWatchlist();
    expect(r).toEqual([{ symbol: "A" }]);
  });

  it("addToWatchlist returns existing if found", async () => {
    dbMock.watchlistStock.findUnique.mockResolvedValue({ symbol: "AAA" });
    const { addToWatchlist } = await import("@/lib/actions");
    const r = await addToWatchlist("AAA", "A name");
    expect(r).toEqual({ symbol: "AAA" });
    expect(dbMock.watchlistStock.create).not.toHaveBeenCalled();
  });

  it("addToWatchlist creates new and uppercases", async () => {
    dbMock.watchlistStock.findUnique.mockResolvedValue(null);
    dbMock.watchlistStock.create.mockResolvedValue({ symbol: "BBB" });
    const { addToWatchlist } = await import("@/lib/actions");
    const r = await addToWatchlist("bbb", "B name", "Tech");
    expect(r).toEqual({ symbol: "BBB" });
    expect(dbMock.watchlistStock.create).toHaveBeenCalledWith({
      data: { symbol: "BBB", name: "B name", sector: "Tech" },
    });
  });

  it("removeFromWatchlist deletes alerts and stock", async () => {
    dbMock.alert.deleteMany.mockResolvedValue({});
    dbMock.watchlistStock.delete.mockResolvedValue({});
    const { removeFromWatchlist } = await import("@/lib/actions");
    await removeFromWatchlist("XYZ");
    expect(dbMock.alert.deleteMany).toHaveBeenCalledWith({ where: { symbol: "XYZ" } });
    expect(dbMock.watchlistStock.delete).toHaveBeenCalledWith({ where: { symbol: "XYZ" } });
  });

  it("getStockDetail fetches quote, history and analysis", async () => {
    marketMock.getHistory.mockResolvedValue([{ close: 1 }]);
    marketMock.getQuote.mockResolvedValue({ symbol: "X", price: 5 });
    analysisMock.analyzeStock.mockReturnValue({ symbol: "X" });
    const { getStockDetail } = await import("@/lib/actions");
    const r = await getStockDetail("X");
    expect(r.quote.price).toBe(5);
    expect(r.history.length).toBe(1);
    expect(r.analysis.symbol).toBe("X");
  });

  it("getPortfolio computes pl and uses sell signals", async () => {
    const buyDate = new Date("2026-01-01");
    dbMock.position.findMany.mockResolvedValue([
      {
        id: "p1",
        symbol: "AAA",
        shares: 10,
        buyPrice: 100,
        buyDate,
        stock: { name: "Alpha" },
      },
      {
        id: "p2",
        symbol: "BBB",
        shares: 5,
        buyPrice: 50,
        buyDate,
        stock: { name: "Beta" },
      },
    ]);
    marketMock.getQuotes.mockResolvedValue([
      { symbol: "AAA", price: 110 },
      // BBB missing on purpose -> uses buyPrice
    ]);
    marketMock.getHistory.mockImplementation(async (sym: string) => {
      if (sym === "AAA") return Array.from({ length: 10 }, () => ({ close: 1 }));
      throw new Error("history fail"); // covers catch path
    });
    analysisMock.analyzeStock.mockReturnValue({ symbol: "X" });
    analysisMock.getSellSignal.mockReturnValue({ reason: "r", urgency: "high" });

    const { getPortfolio } = await import("@/lib/actions");
    const r = await getPortfolio();
    expect(r.length).toBe(2);
    expect(r[0].pl).toBe((110 - 100) * 10);
    expect(r[0].sellSignal?.urgency).toBe("high");
    expect(r[1].currentPrice).toBe(50); // fallback to buyPrice
    expect(r[1].sellSignal).toBeUndefined();
  });

  it("getPortfolio skips analysis when history < 6 bars", async () => {
    dbMock.position.findMany.mockResolvedValue([
      {
        id: "p1",
        symbol: "AAA",
        shares: 1,
        buyPrice: 1,
        buyDate: new Date(),
        stock: { name: "A" },
      },
    ]);
    marketMock.getQuotes.mockResolvedValue([{ symbol: "AAA", price: 2 }]);
    marketMock.getHistory.mockResolvedValue([{ close: 1 }, { close: 2 }]);
    analysisMock.getSellSignal.mockReturnValue(null);

    const { getPortfolio } = await import("@/lib/actions");
    const r = await getPortfolio();
    expect(r[0].sellSignal).toBeUndefined();
    expect(analysisMock.analyzeStock).not.toHaveBeenCalled();
  });

  it("buyStock creates a position", async () => {
    dbMock.position.create.mockResolvedValue({ id: "x" });
    const { buyStock } = await import("@/lib/actions");
    const r = await buyStock("AAA", 1, 10, "note");
    expect(r).toEqual({ id: "x" });
    expect(dbMock.position.create).toHaveBeenCalledWith({
      data: { symbol: "AAA", shares: 1, buyPrice: 10, notes: "note", status: "open" },
    });
  });

  it("sellStock throws when position not found", async () => {
    dbMock.position.findUnique.mockResolvedValue(null);
    const { sellStock } = await import("@/lib/actions");
    await expect(sellStock("missing")).rejects.toThrow("Position not found");
  });

  it("sellStock uses live quote when available", async () => {
    dbMock.position.findUnique.mockResolvedValue({ id: "p", symbol: "A", buyPrice: 50 });
    marketMock.getQuote.mockResolvedValue({ price: 60 });
    dbMock.position.update.mockResolvedValue({});
    const { sellStock } = await import("@/lib/actions");
    await sellStock("p");
    expect(dbMock.position.update).toHaveBeenCalledWith({
      where: { id: "p" },
      data: expect.objectContaining({ status: "closed", sellPrice: 60 }),
    });
  });

  it("sellStock falls back to buyPrice when quote fails", async () => {
    dbMock.position.findUnique.mockResolvedValue({ id: "p", symbol: "A", buyPrice: 50 });
    marketMock.getQuote.mockRejectedValue(new Error("boom"));
    dbMock.position.update.mockResolvedValue({});
    const { sellStock } = await import("@/lib/actions");
    await sellStock("p");
    expect(dbMock.position.update).toHaveBeenCalledWith({
      where: { id: "p" },
      data: expect.objectContaining({ sellPrice: 50 }),
    });
  });

  it("removePosition deletes", async () => {
    dbMock.position.delete.mockResolvedValue({});
    const { removePosition } = await import("@/lib/actions");
    await removePosition("p");
    expect(dbMock.position.delete).toHaveBeenCalledWith({ where: { id: "p" } });
  });

  it("createAlert creates with threshold", async () => {
    dbMock.alert.create.mockResolvedValue({ id: "a" });
    const { createAlert } = await import("@/lib/actions");
    const r = await createAlert("A", "price", "above", 100);
    expect(r).toEqual({ id: "a" });
    expect(dbMock.alert.create).toHaveBeenCalledWith({
      data: { symbol: "A", type: "price", condition: "above", threshold: 100 },
    });
  });

  it("getAlerts filters by symbol when provided", async () => {
    dbMock.alert.findMany.mockResolvedValue([]);
    const { getAlerts } = await import("@/lib/actions");
    await getAlerts("A");
    expect(dbMock.alert.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { symbol: "A", triggered: false } })
    );
    await getAlerts();
    expect(dbMock.alert.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { triggered: false } })
    );
  });

  it("getTradeHistory queries closed positions", async () => {
    dbMock.position.findMany.mockResolvedValue([{ id: "1" }]);
    const { getTradeHistory } = await import("@/lib/actions");
    const r = await getTradeHistory();
    expect(r.length).toBe(1);
    expect(dbMock.position.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "closed" } })
    );
  });
});
