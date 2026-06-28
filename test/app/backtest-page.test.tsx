import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BacktestPage from "@/app/backtest/page";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";

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
  return { ok: true, status: 200, body: stream };
}

const TRADE = {
  symbol: "AAPL",
  entryDate: "2026-01-15T00:00:00.000Z",
  entryPrice: 180.5,
  exitDate: "2026-02-10T00:00:00.000Z",
  exitPrice: 195.2,
  shares: 50,
  exitReason: "target" as const,
  pl: 735,
  plPct: 8.14,
  signalsAtEntry: ["RSI Oversold"],
  scoreAtEntry: 65,
};

const FULL_RESULT = {
  trades: [TRADE],
  equityCurve: [{ date: "2026-01-15", equity: 50_000 }],
  summary: {
    symbolsConsidered: 1,
    symbolsWithEnoughHistory: 1,
    tradesCount: 1,
    winningTrades: 1,
    losingTrades: 0,
    startingCapital: 50_000,
    endingCapital: 50_735,
    totalReturn: 735,
    totalReturnPct: 1.47,
    cashRemaining: 50_735,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BacktestPage", () => {
  it("renders the form with date inputs + survivorship banner", () => {
    render(<BacktestPage />);
    expect(screen.getByText(/Backtest$/)).toBeInTheDocument();
    expect(screen.getByText(/Survivorship bias/)).toBeInTheDocument();
    expect(screen.getByText("Run backtest")).toBeInTheDocument();
    expect(screen.getByText(/Start date/)).toBeInTheDocument();
    expect(screen.getByText(/End date/)).toBeInTheDocument();
  });

  it("clicking Run streams progress then renders summary card + trade table", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      ndjsonStreamResponse([
        {
          kind: "start",
          startDate: "2026-01-01",
          endDate: "2026-02-28",
          startingCapital: 50_000,
        },
        {
          kind: "progress",
          day: 1,
          totalDays: 3,
          date: "2026-01-05",
          equity: 50_000,
          openPositions: 0,
          tradesClosed: 0,
        },
        {
          kind: "progress",
          day: 2,
          totalDays: 3,
          date: "2026-01-06",
          equity: 50_100,
          openPositions: 1,
          tradesClosed: 0,
        },
        {
          kind: "progress",
          day: 3,
          totalDays: 3,
          date: "2026-01-07",
          equity: 50_735,
          openPositions: 0,
          tradesClosed: 1,
        },
        { kind: "done", runId: "run-1", result: FULL_RESULT },
      ])
    ) as unknown as typeof fetch;

    render(<BacktestPage />);
    fireEvent.click(screen.getByText("Run backtest"));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringMatching(/Backtest done: 1 trades, return 1\.47%/)
      );
    });

    // Summary card
    expect(screen.getByText(/\+1\.47%/)).toBeInTheDocument();
    // P&L appears in both the summary card and the trade row.
    expect(screen.getAllByText(/\+\$735/).length).toBeGreaterThanOrEqual(1);
    // Trade row
    expect(screen.getByText("AAPL")).toBeInTheDocument();
    expect(screen.getByText(/target/i)).toBeInTheDocument();
  });

  it("emits an error toast on stream error", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      ndjsonStreamResponse([
        { kind: "start" },
        { kind: "error", message: "DB exploded" },
      ])
    ) as unknown as typeof fetch;
    render(<BacktestPage />);
    fireEvent.click(screen.getByText("Run backtest"));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("DB exploded");
    });
  });

  it("emits an error toast when stream ends without a done event", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      ndjsonStreamResponse([{ kind: "start" }])
    ) as unknown as typeof fetch;
    render(<BacktestPage />);
    fireEvent.click(screen.getByText("Run backtest"));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringMatching(/no result received/)
      );
    });
  });

  it("surfaces a 400 from the API as a toast", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "Invalid 'startDate'" }),
    }) as unknown as typeof fetch;
    render(<BacktestPage />);
    fireEvent.click(screen.getByText("Run backtest"));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Invalid 'startDate'");
    });
  });

  it("shows 'No trades generated' note when result is empty", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      ndjsonStreamResponse([
        { kind: "start" },
        {
          kind: "done",
          runId: "r0",
          result: {
            ...FULL_RESULT,
            trades: [],
            summary: { ...FULL_RESULT.summary, tradesCount: 0 },
          },
        },
      ])
    ) as unknown as typeof fetch;
    render(<BacktestPage />);
    fireEvent.click(screen.getByText("Run backtest"));
    await waitFor(() => {
      expect(screen.getByText(/No trades generated/)).toBeInTheDocument();
    });
  });

  it("paginates when trades > 25", async () => {
    const trades = Array.from({ length: 30 }, (_, i) => ({
      ...TRADE,
      symbol: `S${i.toString().padStart(2, "0")}`,
    }));
    global.fetch = vi.fn().mockResolvedValue(
      ndjsonStreamResponse([
        { kind: "start" },
        {
          kind: "done",
          runId: "r0",
          result: {
            ...FULL_RESULT,
            trades,
            summary: { ...FULL_RESULT.summary, tradesCount: 30 },
          },
        },
      ])
    ) as unknown as typeof fetch;
    render(<BacktestPage />);
    fireEvent.click(screen.getByText("Run backtest"));
    await waitFor(() =>
      expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument()
    );
    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByText(/Page 2 of 2/)).toBeInTheDocument();
  });
});
