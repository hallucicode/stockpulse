import { describe, it, expect, beforeEach } from "vitest";
import { useStore } from "@/hooks/use-store";

describe("useStore", () => {
  beforeEach(() => {
    useStore.setState({
      view: "scanner",
      scannerData: [],
      scannerLoading: true,
      scannerLastUpdated: null,
      sortBy: "score",
      sectorFilter: "All",
      selectedSymbol: null,
      portfolio: [],
      portfolioLoading: true,
    });
  });

  it("setView updates view", () => {
    useStore.getState().setView("portfolio");
    expect(useStore.getState().view).toBe("portfolio");
  });

  it("setScannerData stops loading and stores lastUpdated", () => {
    useStore.getState().setScannerData(
      [{ symbol: "X", name: "X", sector: "T", analysis: {} as any }],
      "2026-01-01"
    );
    const s = useStore.getState();
    expect(s.scannerLoading).toBe(false);
    expect(s.scannerLastUpdated).toBe("2026-01-01");
    expect(s.scannerData.length).toBe(1);
  });

  it("setScannerData defaults lastUpdated to null", () => {
    useStore.getState().setScannerData([]);
    expect(useStore.getState().scannerLastUpdated).toBeNull();
  });

  it("setScannerLoading updates flag", () => {
    useStore.getState().setScannerLoading(false);
    expect(useStore.getState().scannerLoading).toBe(false);
  });

  it("setSortBy updates sort", () => {
    useStore.getState().setSortBy("dayChange");
    expect(useStore.getState().sortBy).toBe("dayChange");
  });

  it("setSectorFilter updates sector", () => {
    useStore.getState().setSectorFilter("Tech");
    expect(useStore.getState().sectorFilter).toBe("Tech");
  });

  it("setSelectedSymbol updates symbol", () => {
    useStore.getState().setSelectedSymbol("AAPL");
    expect(useStore.getState().selectedSymbol).toBe("AAPL");
  });

  it("setPortfolio sets data and clears loading", () => {
    useStore.getState().setPortfolio([
      {
        id: "1",
        symbol: "X",
        name: "X",
        shares: 1,
        buyPrice: 1,
        buyDate: "",
        currentPrice: 1,
        pl: 0,
        plPct: 0,
        status: "open",
      },
    ]);
    const s = useStore.getState();
    expect(s.portfolioLoading).toBe(false);
    expect(s.portfolio.length).toBe(1);
  });

  it("setPortfolioLoading toggles flag", () => {
    useStore.getState().setPortfolioLoading(false);
    expect(useStore.getState().portfolioLoading).toBe(false);
  });
});
