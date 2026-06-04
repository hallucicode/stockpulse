import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScannerView } from "@/components/scanner-view";
import { useStore } from "@/hooks/use-store";
import type { ScannerStock } from "@/hooks/use-store";

// Phase 14 — these tests cover scanner-view's own behaviour: filtering,
// sorting, pagination, search, the news banner, the layout toggle.
//
// The individual card content is covered in:
//   - test/components/trade-card.test.tsx (Detailed mode)
//   - test/components/scanner-table.test.tsx (Compact mode)
//
// Tests below render the default (Detailed → TradeCard) unless the toggle
// describe block explicitly switches.

function makeStock(
  symbol: string,
  sector = "Tech",
  overrides: Record<string, unknown> = {}
): ScannerStock {
  return {
    symbol,
    name: `${symbol} Inc`,
    sector,
    fetchedAt: new Date().toISOString(),
    analysis: {
      symbol,
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
      dayChange: 1,
      weekChange: 0,
      monthChange: 0,
      avgDailyVolatility: 1,
      compositeScore: 10,
      recommendation: "HOLD",
      signals: [
        { label: "S1", detail: "d1", type: "buy", weight: 1 },
        { label: "S2", detail: "d2", type: "sell", weight: -1 },
        { label: "S3", detail: "d3", type: "neutral", weight: 0 },
      ],
      ...overrides,
      // biome-ignore lint/suspicious/noExplicitAny: test factory
    } as any,
  };
}

describe("ScannerView", () => {
  beforeEach(() => {
    useStore.setState({
      view: "scanner",
      scannerData: [],
      scannerLoading: false,
      scannerLastUpdated: null,
      newsHealth: null,
      regime: null,
      vetoedCount: 0,
      sortBy: "score",
      sectorFilter: "All",
      portfolio: [],
      selectedSymbol: null,
    });
    try {
      window.localStorage.removeItem("scanner-view-mode");
    } catch {
      /* no-op */
    }
  });

  afterEach(() => {
    try {
      window.localStorage.removeItem("scanner-view-mode");
    } catch {
      /* no-op */
    }
  });

  it("renders skeletons when loading", () => {
    useStore.setState({ scannerLoading: true });
    const { container } = render(<ScannerView />);
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  it("renders empty state when no stocks match the search", () => {
    useStore.setState({
      scannerData: [makeStock("AAA")],
      scannerLoading: false,
    });
    render(<ScannerView />);
    fireEvent.change(screen.getByPlaceholderText(/Search symbol/), {
      target: { value: "ZZZZZZ" },
    });
    expect(screen.getByText("No stocks found")).toBeInTheDocument();
  });

  it("filters by search (symbol or name)", () => {
    useStore.setState({
      scannerData: [makeStock("AAA"), makeStock("BBB")],
    });
    render(<ScannerView />);
    fireEvent.change(screen.getByPlaceholderText(/Search symbol/), {
      target: { value: "AAA" },
    });
    expect(screen.getByText("AAA")).toBeInTheDocument();
    expect(screen.queryByText("BBB")).toBeNull();
  });

  it("filters by sector", () => {
    useStore.setState({
      scannerData: [makeStock("AAA", "Tech"), makeStock("BBB", "Health")],
    });
    render(<ScannerView />);
    fireEvent.click(screen.getByRole("button", { name: "Health" }));
    expect(screen.queryByText("AAA")).toBeNull();
    expect(screen.getByText("BBB")).toBeInTheDocument();
  });

  it("changes sort order", () => {
    useStore.setState({
      scannerData: [
        makeStock("AAA", "Tech", { compositeScore: 10, dayChange: -1 }),
        makeStock("BBB", "Tech", { compositeScore: 50, dayChange: 5 }),
      ],
    });
    render(<ScannerView />);
    fireEvent.click(screen.getByRole("button", { name: "Top Movers" }));
    fireEvent.click(screen.getByRole("button", { name: "Most Volatile" }));
    fireEvent.click(screen.getByRole("button", { name: "Best Signal" }));
    expect(screen.getByText("BBB")).toBeInTheDocument();
  });

  it("paginates when stocks > PAGE_SIZE", () => {
    const stocks = Array.from({ length: 60 }, (_, i) =>
      makeStock(`S${String(i).padStart(3, "0")}`)
    );
    useStore.setState({ scannerData: stocks });
    render(<ScannerView />);
    expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText(/Page 2 of 2/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Prev"));
    expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();
  });

  it("clicking a TradeCard in detailed mode navigates to detail", () => {
    useStore.setState({ scannerData: [makeStock("AAA")] });
    render(<ScannerView />);
    fireEvent.click(screen.getByText("AAA"));
    expect(useStore.getState().selectedSymbol).toBe("AAA");
    expect(useStore.getState().view).toBe("detail");
  });

  it("renders status bar with tracked / filtered / shown counts", () => {
    useStore.setState({
      scannerData: [makeStock("A")],
      scannerLoading: false,
      vetoedCount: 5,
    });
    render(<ScannerView />);
    expect(screen.getByText(/6 tracked · 5 filtered out · 1 shown/)).toBeInTheDocument();
  });

  it("renders Loading status when loading", () => {
    useStore.setState({ scannerLoading: true });
    render(<ScannerView />);
    expect(screen.getByText(/Loading stocks/)).toBeInTheDocument();
  });

  it("does NOT render the news banner when news is healthy", () => {
    useStore.setState({
      newsHealth: {
        lastIngestAt: new Date().toISOString(),
        ageHours: 0,
        isStale: false,
        isMissing: false,
      },
    });
    render(<ScannerView />);
    expect(screen.queryByText(/News data warning/)).toBeNull();
  });

  it("renders the 'missing' banner when newsHealth.isMissing", () => {
    useStore.setState({
      newsHealth: {
        lastIngestAt: null,
        ageHours: null,
        isStale: true,
        isMissing: true,
      },
    });
    render(<ScannerView />);
    expect(screen.getByText(/News data warning/)).toBeInTheDocument();
    expect(screen.getByText(/News data unavailable/)).toBeInTheDocument();
  });

  it("renders the 'stale' banner when newsHealth.isStale", () => {
    useStore.setState({
      newsHealth: {
        lastIngestAt: new Date(Date.now() - 50 * 3_600_000).toISOString(),
        ageHours: 50,
        isStale: true,
        isMissing: false,
      },
    });
    render(<ScannerView />);
    expect(screen.getByText(/News data warning/)).toBeInTheDocument();
    expect(screen.getByText(/50h old/)).toBeInTheDocument();
  });

  // Phase 14 — layout toggle. Detailed (TradeCard) ↔ Compact (ScannerTable).
  describe("view-mode toggle (Phase 14)", () => {
    it("defaults to detailed (TradeCard) when localStorage is empty", () => {
      useStore.setState({ scannerData: [makeStock("AAA")] });
      render(<ScannerView />);
      // TradeCard renders a "Copy ticket" button; ScannerTable does not.
      expect(screen.getByText("Copy ticket")).toBeInTheDocument();
    });

    it("reads compact mode from localStorage on mount", () => {
      window.localStorage.setItem("scanner-view-mode", "compact");
      useStore.setState({ scannerData: [makeStock("AAA")] });
      render(<ScannerView />);
      // Compact (ScannerTable) doesn't render a Copy ticket button.
      expect(screen.queryByText("Copy ticket")).toBeNull();
      // But it does render the table headers.
      expect(screen.getByText("Sym")).toBeInTheDocument();
      expect(screen.getByText("Score")).toBeInTheDocument();
    });

    it("switches mode when the toggle button is clicked and persists to localStorage", () => {
      useStore.setState({ scannerData: [makeStock("AAA")] });
      render(<ScannerView />);
      // Default state: detailed → button reads "Compact" (action label).
      expect(screen.getByText("Copy ticket")).toBeInTheDocument();
      fireEvent.click(screen.getByText("Compact"));
      // After click: compact view, no Copy ticket, button now reads "Detailed".
      expect(screen.queryByText("Copy ticket")).toBeNull();
      expect(screen.getByText("Detailed")).toBeInTheDocument();
      expect(window.localStorage.getItem("scanner-view-mode")).toBe("compact");
      // Toggle back.
      fireEvent.click(screen.getByText("Detailed"));
      expect(screen.getByText("Copy ticket")).toBeInTheDocument();
      expect(window.localStorage.getItem("scanner-view-mode")).toBe("detailed");
    });

    it("ignores an unrecognised stored value (defensive against schema drift)", () => {
      window.localStorage.setItem("scanner-view-mode", "garbage");
      useStore.setState({ scannerData: [makeStock("AAA")] });
      render(<ScannerView />);
      // Falls back to default (detailed) → Copy ticket is present.
      expect(screen.getByText("Copy ticket")).toBeInTheDocument();
    });

    it("tolerates a localStorage setItem that throws (private mode)", () => {
      // The real-world failure mode in browser private modes is "read OK,
      // write denied". jsdom proxies Storage, so spyOn the prototype.
      const setItemSpy = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(() => {
          throw new Error("denied");
        });
      try {
        useStore.setState({ scannerData: [makeStock("AAA")] });
        render(<ScannerView />);
        expect(screen.getByText("Copy ticket")).toBeInTheDocument();
        // Click toggles in-memory even though setItem throws.
        fireEvent.click(screen.getByText("Compact"));
        expect(screen.queryByText("Copy ticket")).toBeNull();
      } finally {
        setItemSpy.mockRestore();
      }
    });

    it("tolerates a localStorage getItem that throws (private mode)", () => {
      const getItemSpy = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(() => {
          throw new Error("denied");
        });
      try {
        useStore.setState({ scannerData: [makeStock("AAA")] });
        render(<ScannerView />);
        // Default mode applied (detailed) because getItem threw.
        expect(screen.getByText("Copy ticket")).toBeInTheDocument();
      } finally {
        getItemSpy.mockRestore();
      }
    });

    it("passes the computed portfolioValueUsd to TradeCard for sizing", () => {
      useStore.setState({
        portfolio: [
          {
            id: "p1",
            symbol: "MSFT",
            name: "Microsoft",
            shares: 100,
            buyPrice: 300,
            buyDate: "2026-01-01",
            currentPrice: 400, // → $40k contribution
            pl: 10000,
            plPct: 33,
            status: "open",
          },
        ],
        scannerData: [
          makeStock("AAA", "Tech", {
            risk: {
              atr: 1,
              entry: 50,
              stop: 30,
              stopMethod: "atr",
              target: 110,
              riskReward: 3,
            },
          }),
        ],
      });
      render(<ScannerView />);
      // 1% of $40k = $400 risk budget; $20/share risk → 20 shares.
      expect(screen.getByText(/20 shares/)).toBeInTheDocument();
    });
  });
});
