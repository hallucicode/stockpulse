import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import HistoricalPage from "@/app/historical/page";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";

const SUMMARIES = [
  {
    symbol: "AAPL",
    barCount: 1260,
    firstDate: "2021-06-30T00:00:00.000Z",
    lastDate: "2026-06-30T00:00:00.000Z",
    gapCount: 0,
  },
  {
    symbol: "GME",
    barCount: 0,
    firstDate: null,
    lastDate: null,
    gapCount: 0,
  },
  {
    symbol: "AMC",
    barCount: 100,
    firstDate: "2021-06-30T00:00:00.000Z",
    lastDate: "2021-12-31T00:00:00.000Z",
    gapCount: 2,
  },
];

const BARS_AAPL = [
  {
    date: "2021-06-30T00:00:00.000Z",
    open: 100,
    high: 105,
    low: 99,
    close: 102,
    volume: 1_000_000,
  },
  {
    date: "2021-07-01T00:00:00.000Z",
    open: 102,
    high: 108,
    low: 101,
    close: 107,
    volume: 1_200_000,
  },
];

function mockFetch(handlers: Record<string, () => unknown>) {
  global.fetch = vi.fn().mockImplementation((url: string) => {
    for (const [pattern, value] of Object.entries(handlers)) {
      if (url.includes(pattern)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => value(),
        });
      }
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      json: async () => ({ error: "not mocked: " + url }),
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("HistoricalPage", () => {
  it("renders the summary table after fetching /api/historical/symbols", async () => {
    mockFetch({
      "/api/historical/symbols": () => ({
        count: SUMMARIES.length,
        summaries: SUMMARIES,
      }),
    });
    render(<HistoricalPage />);
    await waitFor(() => {
      expect(screen.getByText("AAPL")).toBeInTheDocument();
      expect(screen.getByText("GME")).toBeInTheDocument();
      expect(screen.getByText("AMC")).toBeInTheDocument();
    });
    expect(screen.getByText("1,260")).toBeInTheDocument();
    // GME has 0 bars (and 0 gaps); AAPL has 0 gaps. So "0" appears 3 times.
    expect(screen.getAllByText("0").length).toBeGreaterThanOrEqual(1);
    // AMC has 2 gaps — flagged amber via colour but text remains "2".
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders the empty state when there are no watchlist symbols", async () => {
    mockFetch({
      "/api/historical/symbols": () => ({ count: 0, summaries: [] }),
    });
    render(<HistoricalPage />);
    await waitFor(() => {
      expect(screen.getByText(/No watchlist symbols/)).toBeInTheDocument();
    });
  });

  it("expands a row and renders the sparkline + price stats", async () => {
    mockFetch({
      "/api/historical/symbols": () => ({
        count: SUMMARIES.length,
        summaries: SUMMARIES,
      }),
      "/api/historical/bars/AAPL": () => ({
        symbol: "AAPL",
        count: 2,
        bars: BARS_AAPL,
      }),
    });
    render(<HistoricalPage />);
    await waitFor(() => {
      expect(screen.getByText("AAPL")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("AAPL"));
    await waitFor(() => {
      expect(screen.getByText(/Latest: \$107.00/)).toBeInTheDocument();
      expect(screen.getByText(/Low: \$102.00/)).toBeInTheDocument();
      expect(screen.getByText(/High: \$107.00/)).toBeInTheDocument();
    });
  });

  it("collapses an expanded row when clicked again", async () => {
    mockFetch({
      "/api/historical/symbols": () => ({
        count: SUMMARIES.length,
        summaries: SUMMARIES,
      }),
      "/api/historical/bars/AAPL": () => ({
        symbol: "AAPL",
        count: 2,
        bars: BARS_AAPL,
      }),
    });
    render(<HistoricalPage />);
    await waitFor(() => screen.getByText("AAPL"));
    fireEvent.click(screen.getByText("AAPL"));
    await waitFor(() => screen.getByText(/Latest:/));
    fireEvent.click(screen.getByText("AAPL"));
    expect(screen.queryByText(/Latest:/)).toBeNull();
  });

  it("shows 'No bars cached' message when the symbol has zero bars after expand", async () => {
    mockFetch({
      "/api/historical/symbols": () => ({
        count: SUMMARIES.length,
        summaries: SUMMARIES,
      }),
      "/api/historical/bars/GME": () => ({
        symbol: "GME",
        count: 0,
        bars: [],
      }),
    });
    render(<HistoricalPage />);
    await waitFor(() => screen.getByText("GME"));
    fireEvent.click(screen.getByText("GME"));
    await waitFor(() => {
      expect(screen.getByText(/No bars cached/)).toBeInTheDocument();
    });
  });

  it("triggers backfill on button click and toasts the summary", async () => {
    mockFetch({
      "/api/historical/symbols": () => ({
        count: SUMMARIES.length,
        summaries: SUMMARIES,
      }),
      "/api/historical/backfill": () => ({
        totalSymbols: 3,
        succeeded: 2,
        empty: 1,
        errored: 0,
        totalBarsWritten: 2520,
      }),
    });
    render(<HistoricalPage />);
    await waitFor(() => screen.getByText("AAPL"));
    fireEvent.click(screen.getByText(/Backfill watchlist/));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringMatching(/Backfill done: 2\/3 symbols/)
      );
    });
  });

  it("toasts an error when backfill returns non-OK", async () => {
    let calls = 0;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      calls++;
      if (url.includes("/api/historical/backfill")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({}),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ count: 0, summaries: SUMMARIES }),
      });
    }) as unknown as typeof fetch;
    render(<HistoricalPage />);
    await waitFor(() => screen.getByText("AAPL"));
    fireEvent.click(screen.getByText(/Backfill watchlist/));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/Backfill failed/)
      );
    });
    expect(calls).toBeGreaterThan(0);
  });

  it("renders the loading state initially, then the table", async () => {
    let resolveSummaries: (v: unknown) => void = () => {};
    global.fetch = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => {
        resolveSummaries = resolve;
      });
    }) as unknown as typeof fetch;
    render(<HistoricalPage />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    resolveSummaries({
      ok: true,
      status: 200,
      json: async () => ({ count: 0, summaries: [] }),
    });
    await waitFor(() => {
      expect(screen.getByText(/No watchlist symbols/)).toBeInTheDocument();
    });
  });

  it("renders empty summaries when /symbols call fails (no UI crash)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }) as unknown as typeof fetch;
    render(<HistoricalPage />);
    await waitFor(() => {
      expect(screen.getByText(/No watchlist symbols/)).toBeInTheDocument();
    });
  });
});
