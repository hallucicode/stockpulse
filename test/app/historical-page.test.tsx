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

/**
 * Build a Response body that streams pre-baked NDJSON events. Used by the
 * backfill-page tests since the API now streams instead of returning JSON.
 */
function ndjsonStreamResponse(events: unknown[]): unknown {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      }
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    body: stream,
  };
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

  it("triggers backfill on button click, renders the progress card, toasts the final summary", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/historical/symbols")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            count: SUMMARIES.length,
            summaries: SUMMARIES,
          }),
        });
      }
      if (url.includes("/api/historical/backfill")) {
        return Promise.resolve(
          ndjsonStreamResponse([
            { kind: "start", years: 5 },
            {
              kind: "progress",
              symbol: "AAPL",
              processed: 1,
              total: 3,
              barsWrittenThisSymbol: 1260,
              status: "ok",
            },
            {
              kind: "progress",
              symbol: "GME",
              processed: 2,
              total: 3,
              barsWrittenThisSymbol: 0,
              status: "empty",
            },
            {
              kind: "progress",
              symbol: "AMC",
              processed: 3,
              total: 3,
              barsWrittenThisSymbol: 1260,
              status: "ok",
            },
            {
              kind: "done",
              totalSymbols: 3,
              succeeded: 2,
              empty: 1,
              errored: 0,
              totalBarsWritten: 2520,
            },
          ])
        );
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    }) as unknown as typeof fetch;
    render(<HistoricalPage />);
    await waitFor(() => screen.getByText("AAPL"));
    fireEvent.click(screen.getByText(/Backfill watchlist/));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringMatching(/Backfill done: 2\/3 symbols/)
      );
    });
  });

  it("surfaces a stream-error event as a toast.error", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/historical/symbols")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ count: 0, summaries: SUMMARIES }),
        });
      }
      if (url.includes("/api/historical/backfill")) {
        return Promise.resolve(
          ndjsonStreamResponse([
            { kind: "start", years: 5 },
            { kind: "error", message: "yahoo down" },
          ])
        );
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    }) as unknown as typeof fetch;
    render(<HistoricalPage />);
    await waitFor(() => screen.getByText("AAPL"));
    fireEvent.click(screen.getByText(/Backfill watchlist/));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/Backfill failed/)
      );
    });
  });

  it("warns when the stream ends without a 'done' event", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/historical/symbols")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ count: 0, summaries: SUMMARIES }),
        });
      }
      if (url.includes("/api/historical/backfill")) {
        return Promise.resolve(
          ndjsonStreamResponse([
            { kind: "start", years: 5 },
            // stream ends after start, no progress, no done.
          ])
        );
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    }) as unknown as typeof fetch;
    render(<HistoricalPage />);
    await waitFor(() => screen.getByText("AAPL"));
    fireEvent.click(screen.getByText(/Backfill watchlist/));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/finished but no summary/)
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
