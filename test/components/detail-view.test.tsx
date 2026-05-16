import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DetailView } from "@/components/detail-view";
import { useStore } from "@/hooks/use-store";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/use-data", () => ({
  executeBuy: vi.fn(),
  executeSell: vi.fn(),
  executeRemove: vi.fn(),
}));

import { executeBuy, executeSell } from "@/hooks/use-data";

function makeStock(symbol = "AAA", overrides: any = {}) {
  return {
    symbol,
    name: `${symbol} Inc`,
    sector: "Tech",
    fetchedAt: new Date().toISOString(),
    analysis: {
      symbol,
      price: 100,
      rsi: 50,
      sma20: 99,
      sma50: 95,
      bollingerUpper: 110,
      bollingerLower: 90,
      bollingerMid: 100,
      macdLine: 1,
      macdSignal: 0.5,
      macdHistogram: 0.5,
      dayChange: 1,
      weekChange: 2,
      monthChange: 5,
      avgDailyVolatility: 1,
      compositeScore: 20,
      recommendation: "BUY",
      signals: [
        { label: "S1", detail: "d1", type: "buy", weight: 1 },
        { label: "S2", detail: "d2", type: "sell", weight: -1 },
        { label: "S3", detail: "d3", type: "neutral", weight: 0 },
      ],
      ...overrides,
    } as any,
  };
}

describe("DetailView", () => {
  beforeEach(() => {
    useStore.setState({
      view: "detail",
      scannerData: [],
      selectedSymbol: null,
      portfolio: [],
    });
    vi.clearAllMocks();
    // Route mock — news returns the structured shape, everything else (e.g.
    // /api/portfolio) returns the legacy []. Tests that need other shapes
    // override `global.fetch` after this default.
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.startsWith("/api/news/")) {
        return { ok: true, json: async () => ({ items: [], count: 0 }) };
      }
      return { ok: true, json: async () => [] };
    }) as any;
  });

  it("renders not-found when stock missing", () => {
    useStore.setState({ selectedSymbol: "MISSING" });
    render(<DetailView />);
    expect(screen.getByText("Stock not found")).toBeInTheDocument();
    fireEvent.click(screen.getByText("← Back to Scanner"));
    expect(useStore.getState().view).toBe("scanner");
  });

  it("renders not-found when no symbol selected", () => {
    render(<DetailView />);
    expect(screen.getByText("Stock not found")).toBeInTheDocument();
  });

  it("renders details for found stock and shows Buy button", () => {
    useStore.setState({
      selectedSymbol: "AAA",
      scannerData: [makeStock("AAA", { compositeScore: 50 })],
    });
    render(<DetailView />);
    expect(screen.getByText("AAA")).toBeInTheDocument();
    expect(screen.getByText(/Buy/)).toBeInTheDocument();
  });

  it("Back navigates to scanner when not owned", () => {
    useStore.setState({
      selectedSymbol: "AAA",
      scannerData: [makeStock("AAA")],
    });
    render(<DetailView />);
    fireEvent.click(screen.getByText("← Back"));
    expect(useStore.getState().view).toBe("scanner");
  });

  it("Back navigates to portfolio when owned", () => {
    useStore.setState({
      selectedSymbol: "AAA",
      scannerData: [makeStock("AAA")],
      portfolio: [
        {
          id: "p1",
          symbol: "AAA",
          name: "A",
          shares: 1,
          buyPrice: 100,
          buyDate: "2026-01-01T00:00:00Z",
          currentPrice: 100,
          pl: 0,
          plPct: 0,
          status: "open",
        } as any,
      ],
    });
    render(<DetailView />);
    fireEvent.click(screen.getByText("← Back"));
    expect(useStore.getState().view).toBe("portfolio");
  });

  it("handleBuy success path refreshes portfolio", async () => {
    (executeBuy as any).mockResolvedValue({});
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: "new" }],
    }) as any;
    useStore.setState({
      selectedSymbol: "AAA",
      scannerData: [makeStock("AAA", { compositeScore: 50 })],
    });
    render(<DetailView />);
    fireEvent.click(screen.getByText(/Buy ~/));
    await waitFor(() => {
      expect(executeBuy).toHaveBeenCalled();
      expect(useStore.getState().portfolio.length).toBe(1);
    });
  });

  it("handleBuy error path", async () => {
    (executeBuy as any).mockRejectedValue(new Error("fail"));
    useStore.setState({
      selectedSymbol: "AAA",
      scannerData: [makeStock("AAA", { compositeScore: 50 })],
    });
    render(<DetailView />);
    fireEvent.click(screen.getByText(/Buy ~/));
    await waitFor(() => expect(executeBuy).toHaveBeenCalled());
  });

  it("handleSellAll iterates owned positions", async () => {
    (executeSell as any).mockResolvedValue({});
    useStore.setState({
      selectedSymbol: "AAA",
      scannerData: [makeStock("AAA")],
      portfolio: [
        {
          id: "p1",
          symbol: "AAA",
          name: "A",
          shares: 1,
          buyPrice: 100,
          buyDate: "2026-01-01T00:00:00Z",
          currentPrice: 110,
          pl: 10,
          plPct: 10,
          status: "open",
        } as any,
        {
          id: "p2",
          symbol: "AAA",
          name: "A",
          shares: 1,
          buyPrice: 100,
          buyDate: "2026-01-01T00:00:00Z",
          currentPrice: 110,
          pl: 10,
          plPct: 10,
          status: "open",
        } as any,
      ],
    });
    render(<DetailView />);
    fireEvent.click(screen.getByText(/Sell All AAA/));
    await waitFor(() => {
      expect(executeSell).toHaveBeenCalledTimes(2);
      expect(useStore.getState().portfolio.length).toBe(0);
    });
  });

  it("handleSellAll error path", async () => {
    (executeSell as any).mockRejectedValue(new Error("fail"));
    useStore.setState({
      selectedSymbol: "AAA",
      scannerData: [makeStock("AAA")],
      portfolio: [
        {
          id: "p1",
          symbol: "AAA",
          name: "A",
          shares: 1,
          buyPrice: 100,
          buyDate: "2026-01-01T00:00:00Z",
          currentPrice: 110,
          pl: 10,
          plPct: 10,
          status: "open",
        } as any,
      ],
    });
    render(<DetailView />);
    fireEvent.click(screen.getByText(/Sell All AAA/));
    await waitFor(() => expect(executeSell).toHaveBeenCalled());
  });

  it("Close button on individual position", async () => {
    (executeSell as any).mockResolvedValue({});
    useStore.setState({
      selectedSymbol: "AAA",
      scannerData: [makeStock("AAA")],
      portfolio: [
        {
          id: "p1",
          symbol: "AAA",
          name: "A",
          shares: 1,
          buyPrice: 100,
          buyDate: "2026-01-01T00:00:00Z",
          currentPrice: 110,
          pl: 10,
          plPct: 10,
          status: "open",
        } as any,
      ],
    });
    render(<DetailView />);
    fireEvent.click(screen.getByText("Close"));
    await waitFor(() => {
      expect(executeSell).toHaveBeenCalledWith("p1");
    });
  });

  it("renders news section: loads, lists headlines, links out", async () => {
    useStore.setState({
      selectedSymbol: "AAA",
      scannerData: [makeStock("AAA")],
    });
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.startsWith("/api/news/")) {
        return {
          ok: true,
          json: async () => ({
            count: 2,
            items: [
              {
                id: "1",
                headline: "Acme beats Q1 estimates",
                summary: "...",
                source: "Reuters",
                url: "https://reuters.com/a",
                publishedAt: new Date(Date.now() - 60_000).toISOString(),
              },
              {
                id: "2",
                headline: "Acme launches new product line",
                summary: "...",
                source: "Bloomberg",
                url: "",
                publishedAt: new Date(
                  Date.now() - 6 * 3_600_000
                ).toISOString(),
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => [] };
    }) as any;

    render(<DetailView />);
    await waitFor(() =>
      expect(screen.getByText(/Acme beats Q1 estimates/)).toBeInTheDocument()
    );
    expect(
      screen.getByText(/Acme launches new product line/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Reuters/)).toBeInTheDocument();
    // The headline with a URL should render as an anchor
    const link = screen.getByText(/Acme beats Q1 estimates/);
    expect(link.closest("a")?.getAttribute("href")).toBe("https://reuters.com/a");
  });

  it("renders the empty-state when no news rows", async () => {
    useStore.setState({
      selectedSymbol: "AAA",
      scannerData: [makeStock("AAA")],
    });
    render(<DetailView />);
    await waitFor(() =>
      expect(
        screen.getByText(/No news in the last 30 days/)
      ).toBeInTheDocument()
    );
  });

  it("renders error state when news fetch fails", async () => {
    useStore.setState({
      selectedSymbol: "AAA",
      scannerData: [makeStock("AAA")],
    });
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.startsWith("/api/news/"))
        return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => [] };
    }) as any;

    render(<DetailView />);
    await waitFor(() =>
      expect(screen.getByText(/Couldn't load news/)).toBeInTheDocument()
    );
  });

  it("shows the diagnosis rationale when present", async () => {
    useStore.setState({
      selectedSymbol: "AAA",
      scannerData: [
        makeStock("AAA", {
          diagnosis: {
            category: "earnings_beat",
            rationale: 'Earnings beat — "Acme tops Q3 estimates"',
            newsCount: 5,
            scoreAdjustment: 10,
          },
        }),
      ],
    });
    render(<DetailView />);
    await waitFor(() =>
      expect(
        screen.getByText(/Earnings beat — "Acme tops Q3 estimates"/)
      ).toBeInTheDocument()
    );
  });

  it("renders various recommendation/score colors and indicators", () => {
    const cases = [
      { compositeScore: 50, dayChange: -1, rsi: 25, price: 89, macdHistogram: -1 }, // strong buy color, low RSI, at lower band
      { compositeScore: 20, dayChange: 0, rsi: 50, price: 100 }, // emerald-300
      { compositeScore: 0, dayChange: 0, rsi: 50, price: 100 }, // amber-400
      { compositeScore: -20, dayChange: 0, rsi: 50, price: 100 }, // orange-400
      { compositeScore: -50, dayChange: 0, rsi: 80, price: 111, macdHistogram: 1 }, // rose-400, high RSI, at upper band
    ];
    for (const c of cases) {
      useStore.setState({
        selectedSymbol: "X",
        scannerData: [makeStock("X", c)],
        portfolio: [],
      });
      const { unmount } = render(<DetailView />);
      unmount();
    }
  });
});
