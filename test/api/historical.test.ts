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

/** Helper: read an NDJSON stream Response body to a list of parsed events. */
async function readNdjsonStream(res: Response): Promise<unknown[]> {
  if (!res.body) return [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: unknown[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) events.push(JSON.parse(line));
    }
  }
  if (buffer.trim()) events.push(JSON.parse(buffer));
  return events;
}

describe("POST /api/historical/backfill (NDJSON stream)", () => {
  it("streams start + progress-per-symbol + done events on the happy path", async () => {
    // backfillWatchlist now calls options.onSymbol for each symbol.
    sourceMock.backfillWatchlist.mockImplementation(async (_years, opts) => {
      await opts?.onSymbol?.({
        symbol: "AAPL",
        processed: 1,
        total: 2,
        barsWrittenThisSymbol: 1260,
        status: "ok",
      });
      await opts?.onSymbol?.({
        symbol: "MSFT",
        processed: 2,
        total: 2,
        barsWrittenThisSymbol: 1260,
        status: "ok",
      });
      return {
        totalSymbols: 2,
        succeeded: 2,
        empty: 0,
        errored: 0,
        totalBarsWritten: 2520,
      };
    });
    const res = await postBackfill({ json: async () => ({}) } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/x-ndjson/);
    const events = (await readNdjsonStream(res)) as Array<{ kind: string }>;
    expect(events.map((e) => e.kind)).toEqual([
      "start",
      "progress",
      "progress",
      "done",
    ]);
    expect(sourceMock.backfillWatchlist).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ onSymbol: expect.any(Function) })
    );
  });

  it("respects an explicit years parameter", async () => {
    sourceMock.backfillWatchlist.mockResolvedValue({
      totalSymbols: 1,
      succeeded: 1,
      empty: 0,
      errored: 0,
      totalBarsWritten: 252,
    });
    const res = await postBackfill(makeRequest({ years: 1 }) as never);
    await readNdjsonStream(res); // drain
    expect(sourceMock.backfillWatchlist).toHaveBeenCalledWith(
      1,
      expect.any(Object)
    );
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
    await readNdjsonStream(res);
    expect(sourceMock.backfillWatchlist).toHaveBeenCalledWith(
      5,
      expect.any(Object)
    );
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

  it("emits an inline error event + logs when backfill throws mid-stream", async () => {
    sourceMock.backfillWatchlist.mockRejectedValue(new Error("yahoo down"));
    const res = await postBackfill({ json: async () => ({}) } as never);
    // Even on failure the response is 200 — the error surfaces as a
    // stream event so the client can render it inline.
    expect(res.status).toBe(200);
    const events = (await readNdjsonStream(res)) as Array<{
      kind: string;
      message?: string;
    }>;
    const errorEvent = events.find((e) => e.kind === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.message).toBe("yahoo down");
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
