import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScannerView } from "@/components/scanner-view";
import { useStore } from "@/hooks/use-store";
import type { ScannerStock } from "@/hooks/use-store";
import { CATALYST_CONFIG } from "@/lib/config";

function makeStock(symbol: string, sector = "Tech", overrides: any = {}): ScannerStock {
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
        { label: "S4", detail: "d4", type: "buy", weight: 1 },
      ],
      ...overrides,
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
    // Phase 14 — most of the existing tests assert the *compact* StockCard
    // layout. Phase 14 changed the default to "detailed" (TradeCard), so
    // pin compact mode here. The toggle-specific tests below override.
    try {
      window.localStorage.setItem("scanner-view-mode", "compact");
    } catch {
      // jsdom localStorage should always work; this catch keeps the test
      // resilient against environment changes.
    }
  });

  afterEach(() => {
    try {
      window.localStorage.removeItem("scanner-view-mode");
    } catch {
      // no-op
    }
  });

  it("renders skeletons when loading", () => {
    useStore.setState({ scannerLoading: true });
    const { container } = render(<ScannerView />);
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  it("renders empty state when no stocks match", () => {
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

  it("filters by search and search by name", () => {
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
    // Just check no crash and BBB is rendered
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

  it("clicking a stock card sets selected symbol and view", () => {
    useStore.setState({
      scannerData: [makeStock("AAA")],
      portfolio: [
        {
          id: "p1",
          symbol: "AAA",
          name: "AAA",
          shares: 1,
          buyPrice: 1,
          buyDate: "",
          currentPrice: 1,
          pl: 0,
          plPct: 0,
          status: "open",
        } as any,
      ],
    });
    render(<ScannerView />);
    expect(screen.getByText("OWNED")).toBeInTheDocument();
    fireEvent.click(screen.getByText("AAA"));
    expect(useStore.getState().selectedSymbol).toBe("AAA");
    expect(useStore.getState().view).toBe("detail");
  });

  it("timeAgo formats and re-renders on tick", () => {
    vi.useFakeTimers();
    const old = new Date(Date.now() - 60_000 * 5).toISOString();
    useStore.setState({
      scannerData: [{ ...makeStock("OLD"), fetchedAt: old }],
    });
    render(<ScannerView />);
    expect(screen.getByText(/5m ago/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("timeAgo just now and hours", () => {
    useStore.setState({
      scannerData: [
        {
          ...makeStock("FRESH"),
          fetchedAt: new Date().toISOString(),
        },
        {
          ...makeStock("OLD"),
          fetchedAt: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
        },
      ],
    });
    render(<ScannerView />);
    expect(screen.getByText(/just now/)).toBeInTheDocument();
    expect(screen.getByText(/3h ago/)).toBeInTheDocument();
  });

  it("renders status bar with tracked / filtered / shown counts", () => {
    useStore.setState({
      scannerData: [makeStock("A")],
      scannerLoading: false,
      vetoedCount: 5,
    });
    render(<ScannerView />);
    // 1 visible + 5 vetoed = 6 tracked
    expect(screen.getByText(/6 tracked/)).toBeInTheDocument();
    expect(screen.getByText(/5 filtered out/)).toBeInTheDocument();
    expect(screen.getByText(/1 shown/)).toBeInTheDocument();
  });

  it("renders Loading status when loading", () => {
    useStore.setState({ scannerLoading: true });
    render(<ScannerView />);
    expect(screen.getByText("Loading stocks...")).toBeInTheDocument();
  });

  it("handles negative dayChange formatting", () => {
    useStore.setState({
      scannerData: [makeStock("NEG", "Tech", { dayChange: -2.5 })],
    });
    render(<ScannerView />);
    expect(screen.getByText(/-2.5%/)).toBeInTheDocument();
  });

  it("renders Stop / Target / R:R row when risk packet is present", () => {
    useStore.setState({
      scannerData: [
        makeStock("RR", "Tech", {
          risk: {
            atr: 2,
            entry: 100,
            stop: 95,
            stopMethod: "atr",
            target: 115,
            riskReward: 3,
          },
        }),
      ],
    });
    render(<ScannerView />);
    expect(screen.getByText(/Stop:/)).toBeInTheDocument();
    expect(screen.getByText(/\$95\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Target:/)).toBeInTheDocument();
    expect(screen.getByText(/\$115\.00/)).toBeInTheDocument();
    expect(screen.getByText(/3\.0×/)).toBeInTheDocument();
  });

  it("hides Stop/Target row when risk packet is missing (legacy cache)", () => {
    useStore.setState({
      scannerData: [makeStock("OLD", "Tech", { risk: undefined })],
    });
    render(<ScannerView />);
    expect(screen.queryByText(/Stop:/)).not.toBeInTheDocument();
  });

  it("renders earnings badge when imminent", () => {
    useStore.setState({
      scannerData: [
        makeStock("AAPL", "Tech", {
          earnings: {
            nextDate: "2026-04-30",
            daysUntil: 3,
            imminent: true,
            hour: "amc",
          },
        }),
      ],
    });
    render(<ScannerView />);
    expect(screen.getByText(/EARNINGS IN 3D/)).toBeInTheDocument();
  });

  it("hides earnings badge when not imminent", () => {
    useStore.setState({
      scannerData: [
        makeStock("AAPL", "Tech", {
          earnings: {
            nextDate: "2026-06-01",
            daysUntil: 35,
            imminent: false,
          },
        }),
      ],
    });
    render(<ScannerView />);
    expect(screen.queryByText(/EARNINGS IN/)).not.toBeInTheDocument();
  });

  it("renders confidence stars when catalysts are present (Phase 7)", () => {
    useStore.setState({
      scannerData: [
        makeStock("AAPL", "Tech", {
          catalysts: {
            score: 4,
            present: [
              "earnings_upcoming",
              "insider_cluster",
              "analyst_upgrade",
            ],
            confidence: 3,
          },
        }),
      ],
    });
    render(<ScannerView />);
    // Star count: 3 filled + 2 empty (max stars in CATALYST_CONFIG is 5).
    const stars = screen.getByLabelText(/3 catalysts/);
    expect(stars).toBeInTheDocument();
    expect(stars.textContent).toContain("★★★");
    expect(stars.textContent).toContain("☆☆");
    expect(stars.getAttribute("aria-label")).toContain(
      "Upcoming earnings"
    );
    expect(stars.getAttribute("aria-label")).toContain(
      "Cluster insider buying"
    );
    expect(stars.getAttribute("aria-label")).toContain(
      "Recent analyst upgrade"
    );
  });

  it("includes sector_rotation in the tooltip when the sector is turning up (Phase 7.1)", () => {
    useStore.setState({
      scannerData: [
        makeStock("AAPL", "Tech", {
          catalysts: {
            score: 1,
            present: ["sector_rotation"],
            confidence: 1,
          },
        }),
      ],
    });
    render(<ScannerView />);
    const stars = screen.getByLabelText(/1 catalyst/);
    expect(stars.getAttribute("aria-label")).toContain(
      "Sector turning up after downtrend"
    );
  });

  it("includes fda_event in the tooltip when the stock has a recent FDA approval (Phase 12)", () => {
    useStore.setState({
      scannerData: [
        makeStock("MRK", "Healthcare", {
          catalysts: {
            score: 1,
            present: ["fda_event"],
            confidence: 1,
          },
        }),
      ],
    });
    render(<ScannerView />);
    const stars = screen.getByLabelText(/1 catalyst/);
    expect(stars.getAttribute("aria-label")).toContain(
      "Recent FDA drug approval"
    );
  });

  it("singular tooltip wording with a single catalyst", () => {
    useStore.setState({
      scannerData: [
        makeStock("X", "Tech", {
          catalysts: {
            score: 1,
            present: ["positive_news"],
            confidence: 1,
          },
        }),
      ],
    });
    render(<ScannerView />);
    const stars = screen.getByLabelText(/1 catalyst:/);
    expect(stars.getAttribute("aria-label")).toContain(
      "Positive news catalyst"
    );
  });

  it("hides confidence stars when no catalysts apply", () => {
    useStore.setState({
      scannerData: [
        makeStock("X", "Tech", {
          catalysts: { score: 0, present: [], confidence: 0 },
        }),
      ],
    });
    render(<ScannerView />);
    expect(screen.queryByLabelText(/catalyst/)).not.toBeInTheDocument();
  });

  it("hides confidence stars when catalysts field is missing (legacy cache)", () => {
    useStore.setState({
      scannerData: [makeStock("OLD", "Tech", { catalysts: undefined })],
    });
    render(<ScannerView />);
    expect(screen.queryByLabelText(/catalyst/)).not.toBeInTheDocument();
  });

  it("caps stars at CATALYST_CONFIG.maxStars when confidence exceeds it", () => {
    useStore.setState({
      scannerData: [
        makeStock("X", "Tech", {
          catalysts: {
            score: 99,
            present: [
              "earnings_upcoming",
              "insider_cluster",
              "analyst_upgrade",
              "positive_news",
              "sector_rotation",
            ],
            // Pretend a future Phase 7.x jacks this above maxStars.
            confidence: 10,
          },
        }),
      ],
    });
    render(<ScannerView />);
    const stars = screen.getByLabelText(/catalyst/);
    // No empty slots — fully maxed.
    expect(stars.textContent).not.toContain("☆");
    // Filled count equals CATALYST_CONFIG.maxStars (bumps over time
    // as new catalyst types land — Phase 7=5, Phase 12=6).
    expect((stars.textContent ?? "").match(/★/g)?.length).toBe(
      CATALYST_CONFIG.maxStars
    );
  });

  it("renders the options IV line + unusual call badge when present (Phase 8)", () => {
    useStore.setState({
      scannerData: [
        makeStock("AAPL", "Tech", {
          options: {
            atmIV: 0.42,
            ivRank: 12, // below low threshold → "Low IV" green
            putCallRatio: 0.85,
            skew: 0.03,
            unusualCalls: true,
            unusualPuts: false,
            callVolume: 5000,
            putVolume: 1200,
            callOpenInterest: 1000,
            putOpenInterest: 500,
            scoreAdjustment: 15,
          },
        }),
      ],
    });
    render(<ScannerView />);
    expect(screen.getByText(/IV 42% \(rank 12\)/)).toBeInTheDocument();
    expect(screen.getByText(/P\/C 0\.85/)).toBeInTheDocument();
    expect(screen.getByText(/UNUSUAL CALLS/)).toBeInTheDocument();
  });

  it("renders the unusual put badge but no rank label when history is too short", () => {
    useStore.setState({
      scannerData: [
        makeStock("X", "Tech", {
          options: {
            atmIV: 0.55,
            ivRank: null, // not enough history yet
            putCallRatio: 1.4,
            skew: 0.06,
            unusualCalls: false,
            unusualPuts: true,
            callVolume: 200,
            putVolume: 4000,
            callOpenInterest: 800,
            putOpenInterest: 1000,
            scoreAdjustment: -10,
          },
        }),
      ],
    });
    render(<ScannerView />);
    expect(screen.getByText(/IV 55% \(rank pending\)/)).toBeInTheDocument();
    expect(screen.getByText(/UNUSUAL PUTS/)).toBeInTheDocument();
  });

  it("hides the IV line entirely when no options chain is available", () => {
    useStore.setState({
      scannerData: [
        makeStock("OLD", "Tech", { options: undefined }),
      ],
    });
    render(<ScannerView />);
    expect(screen.queryByText(/^IV /)).not.toBeInTheDocument();
    expect(screen.queryByText(/UNUSUAL/)).not.toBeInTheDocument();
  });

  it("hides Stop/Target row when riskReward is degenerate (zero)", () => {
    useStore.setState({
      scannerData: [
        makeStock("BAD", "Tech", {
          risk: {
            atr: 0,
            entry: 100,
            stop: 100,
            stopMethod: "hard_cap",
            target: 100,
            riskReward: 0,
          },
        }),
      ],
    });
    render(<ScannerView />);
    expect(screen.queryByText(/Stop:/)).not.toBeInTheDocument();
  });

  it("does NOT render the news banner when news is healthy", () => {
    useStore.setState({
      newsHealth: {
        lastIngestAt: new Date().toISOString(),
        ageHours: 1,
        isStale: false,
        isMissing: false,
      },
    });
    render(<ScannerView />);
    expect(screen.queryByText(/News data warning/)).not.toBeInTheDocument();
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

  // Phase 14 — layout toggle. These intentionally don't pin compact in
  // beforeEach because they test the toggle's own behavior.
  describe("view-mode toggle (Phase 14)", () => {
    it("defaults to detailed (TradeCard) when localStorage is empty", () => {
      try {
        window.localStorage.removeItem("scanner-view-mode");
      } catch {
        /* no-op */
      }
      useStore.setState({ scannerData: [makeStock("AAA")] });
      render(<ScannerView />);
      // TradeCard renders a "Copy ticket" button; StockCard does not.
      expect(screen.getByText("Copy ticket")).toBeInTheDocument();
    });

    it("reads compact mode from localStorage on mount", () => {
      try {
        window.localStorage.setItem("scanner-view-mode", "compact");
      } catch {
        /* no-op */
      }
      useStore.setState({ scannerData: [makeStock("AAA")] });
      render(<ScannerView />);
      // Compact (StockCard) does not render a "Copy ticket" button.
      expect(screen.queryByText("Copy ticket")).toBeNull();
    });

    it("switches mode when the toggle button is clicked and persists to localStorage", () => {
      try {
        window.localStorage.removeItem("scanner-view-mode");
      } catch {
        /* no-op */
      }
      useStore.setState({ scannerData: [makeStock("AAA")] });
      render(<ScannerView />);
      // Default state: detailed → button reads "Compact" (i.e. click to switch).
      expect(screen.getByText("Copy ticket")).toBeInTheDocument();
      fireEvent.click(screen.getByText("Compact"));
      // After click: compact view, no Copy ticket, button now reads "Detailed".
      expect(screen.queryByText("Copy ticket")).toBeNull();
      expect(screen.getByText("Detailed")).toBeInTheDocument();
      expect(window.localStorage.getItem("scanner-view-mode")).toBe("compact");
      // And again — switch back.
      fireEvent.click(screen.getByText("Detailed"));
      expect(screen.getByText("Copy ticket")).toBeInTheDocument();
      expect(window.localStorage.getItem("scanner-view-mode")).toBe("detailed");
    });

    it("ignores an unrecognised stored value (defensive against schema drift)", () => {
      try {
        window.localStorage.setItem("scanner-view-mode", "garbage");
      } catch {
        /* no-op */
      }
      useStore.setState({ scannerData: [makeStock("AAA")] });
      render(<ScannerView />);
      // Falls back to default ("detailed") → Copy ticket is present.
      expect(screen.getByText("Copy ticket")).toBeInTheDocument();
    });

    it("tolerates a localStorage setItem that throws (private mode)", () => {
      // The real-world failure mode in browser private modes is "read OK,
      // write denied". Render in default mode, then attempt a toggle —
      // the in-memory mode flip should still work even though persistence
      // fails. jsdom proxies Storage methods, so spyOn the prototype.
      window.localStorage.removeItem("scanner-view-mode");
      const setItemSpy = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(() => {
          throw new Error("denied");
        });
      try {
        useStore.setState({ scannerData: [makeStock("AAA")] });
        render(<ScannerView />);
        // Default mode = detailed.
        expect(screen.getByText("Copy ticket")).toBeInTheDocument();
        // Click toggles in-memory even though setItem throws.
        fireEvent.click(screen.getByText("Compact"));
        expect(screen.queryByText("Copy ticket")).toBeNull();
      } finally {
        setItemSpy.mockRestore();
      }
    });

    it("tolerates a localStorage getItem that throws (private mode)", () => {
      // Cover the catch block in the mount-time read. jsdom returns a
      // proxied Storage where instance-level assignment doesn't take —
      // mock the prototype method instead.
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
      // With a non-empty portfolio, sizing math uses sum(currentPrice × shares).
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
      try {
        window.localStorage.removeItem("scanner-view-mode");
      } catch {
        /* no-op */
      }
      render(<ScannerView />);
      // 1% of $40k = $400 risk budget; $20/share risk → 20 shares.
      // Position cap: 10% × $40k = $4k / $50 = 80 shares — not capped.
      expect(screen.getByText(/20 shares/)).toBeInTheDocument();
    });
  });
});
