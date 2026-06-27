import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { sourceMock, loggerMock } = vi.hoisted(() => ({
  sourceMock: {
    backfillWatchlist: vi.fn(),
    listSymbolSummaries: vi.fn(),
    getSymbolBars: vi.fn(),
  },
  loggerMock: {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));
vi.mock("@/lib/historical-bars-source", () => sourceMock);
vi.mock("@/lib/logger", () => loggerMock);

import { POST as postBackfill } from "@/app/api/historical/backfill/route";
import { GET as getSymbols } from "@/app/api/historical/symbols/route";
import { GET as getBars } from "@/app/api/historical/bars/[symbol]/route";

function makeRequest(body: unknown): unknown {
  return { json: async () => body };
}

beforeEach(() => {
  sourceMock.backfillWatchlist = vi.fn();
  sourceMock.listSymbolSummaries = vi.fn();
  sourceMock.getSymbolBars = vi.fn();
  loggerMock.log.error = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/historical/backfill", () => {
  it("triggers backfill with default years (5) when no body", async () => {
    sourceMock.backfillWatchlist.mockResolvedValue({
      totalSymbols: 3,
      succeeded: 3,
      empty: 0,
      errored: 0,
      totalBarsWritten: 3700,
    });
    const res = await postBackfill({ json: async () => ({}) } as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.totalBarsWritten).toBe(3700);
    expect(sourceMock.backfillWatchlist).toHaveBeenCalledWith(5);
  });

  it("respects an explicit years parameter", async () => {
    sourceMock.backfillWatchlist.mockResolvedValue({
      totalSymbols: 1,
      succeeded: 1,
      empty: 0,
      errored: 0,
      totalBarsWritten: 252,
    });
    await postBackfill(makeRequest({ years: 1 }) as never);
    expect(sourceMock.backfillWatchlist).toHaveBeenCalledWith(1);
  });

  it("tolerates an unparseable body (defaults applied)", async () => {
    sourceMock.backfillWatchlist.mockResolvedValue({
      totalSymbols: 0,
      succeeded: 0,
      empty: 0,
      errored: 0,
      totalBarsWritten: 0,
    });
    const res = await postBackfill({
      json: async () => {
        throw new Error("bad json");
      },
    } as never);
    expect(res.status).toBe(200);
    expect(sourceMock.backfillWatchlist).toHaveBeenCalledWith(5);
  });

  it("returns 400 on a years value outside the allowed range", async () => {
    const tooSmall = await postBackfill(makeRequest({ years: 0 }) as never);
    expect(tooSmall.status).toBe(400);
    const tooBig = await postBackfill(makeRequest({ years: 100 }) as never);
    expect(tooBig.status).toBe(400);
    expect(sourceMock.backfillWatchlist).not.toHaveBeenCalled();
  });

  it("returns 400 on a non-numeric years value", async () => {
    const res = await postBackfill(
      makeRequest({ years: "five" }) as never
    );
    expect(res.status).toBe(400);
  });

  it("returns 500 + logs when backfill throws", async () => {
    sourceMock.backfillWatchlist.mockRejectedValue(new Error("yahoo down"));
    const res = await postBackfill({ json: async () => ({}) } as never);
    expect(res.status).toBe(500);
    expect(loggerMock.log.error).toHaveBeenCalledWith(
      "api.historical",
      "backfill.error",
      expect.any(Object)
    );
  });
});

describe("GET /api/historical/symbols", () => {
  it("returns summaries + count", async () => {
    sourceMock.listSymbolSummaries.mockResolvedValue([
      {
        symbol: "AAA",
        barCount: 10,
        firstDate: "2026-01-05T00:00:00.000Z",
        lastDate: "2026-01-20T00:00:00.000Z",
        gapCount: 0,
      },
      {
        symbol: "BBB",
        barCount: 0,
        firstDate: null,
        lastDate: null,
        gapCount: 0,
      },
    ]);
    const res = await getSymbols();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.summaries[1].barCount).toBe(0);
  });

  it("returns 500 on source failure", async () => {
    sourceMock.listSymbolSummaries.mockRejectedValue(new Error("db down"));
    const res = await getSymbols();
    expect(res.status).toBe(500);
    expect(loggerMock.log.error).toHaveBeenCalledWith(
      "api.historical",
      "symbols.error",
      expect.any(Object)
    );
  });
});

describe("GET /api/historical/bars/[symbol]", () => {
  it("returns bars for the symbol", async () => {
    sourceMock.getSymbolBars.mockResolvedValue([
      {
        date: "2026-01-05T00:00:00.000Z",
        open: 100,
        high: 105,
        low: 95,
        close: 102,
        volume: 1_000_000,
      },
    ]);
    const res = await getBars({} as never, {
      params: { symbol: "aapl" },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.symbol).toBe("AAPL"); // uppercased
    expect(body.count).toBe(1);
    expect(body.bars[0].close).toBe(102);
  });

  it("returns 400 when symbol is missing/empty", async () => {
    const res = await getBars({} as never, {
      params: { symbol: "" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 500 when source throws", async () => {
    sourceMock.getSymbolBars.mockRejectedValue(new Error("db down"));
    const res = await getBars({} as never, {
      params: { symbol: "AAA" },
    });
    expect(res.status).toBe(500);
    expect(loggerMock.log.error).toHaveBeenCalledWith(
      "api.historical",
      "bars.error",
      expect.any(Object)
    );
  });
});
