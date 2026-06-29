import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { sourceMock, loggerMock } = vi.hoisted(() => ({
  sourceMock: {
    runAndPersistBacktest: vi.fn(),
    listBacktestRuns: vi.fn(),
  },
  loggerMock: {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock("@/lib/backtest-source", () => sourceMock);
vi.mock("@/lib/logger", () => loggerMock);

import { POST as postRun } from "@/app/api/backtest/run/route";
import { GET as getRuns } from "@/app/api/backtest/runs/route";

function makeRequest(body: unknown): unknown {
  return { json: async () => body };
}

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

beforeEach(() => {
  sourceMock.runAndPersistBacktest = vi.fn();
  sourceMock.listBacktestRuns = vi.fn();
  loggerMock.log.error = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/backtest/run", () => {
  it("streams start + progress + done on the happy path", async () => {
    sourceMock.runAndPersistBacktest.mockImplementation(async (_p, opts) => {
      await opts?.onProgress?.({
        kind: "progress",
        day: 1,
        totalDays: 3,
        date: "2026-01-05",
        equity: 50_000,
        openPositions: 0,
        tradesClosed: 0,
      });
      await opts?.onProgress?.({
        kind: "progress",
        day: 2,
        totalDays: 3,
        date: "2026-01-06",
        equity: 50_500,
        openPositions: 1,
        tradesClosed: 0,
      });
      return {
        runId: "run-1",
        result: { summary: { tradesCount: 0 } },
      };
    });
    const res = await postRun(
      makeRequest({
        startDate: "2026-01-05",
        endDate: "2026-01-07",
        startingCapital: 50_000,
      }) as never
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/x-ndjson/);
    const events = (await readNdjsonStream(res)) as Array<{ kind: string }>;
    expect(events.map((e) => e.kind)).toEqual([
      "start",
      "progress",
      "progress",
      "done",
    ]);
  });

  it("returns 400 for missing/malformed startDate", async () => {
    const res = await postRun(makeRequest({ endDate: "2026-01-31" }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/startDate/);
  });

  it("returns 400 for missing/malformed endDate", async () => {
    const res = await postRun(
      makeRequest({ startDate: "2026-01-01" }) as never
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when endDate is before startDate", async () => {
    const res = await postRun(
      makeRequest({
        startDate: "2026-02-01",
        endDate: "2026-01-01",
      }) as never
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when startDate has the wrong format", async () => {
    const res = await postRun(
      makeRequest({
        startDate: "01/01/2026",
        endDate: "2026-12-31",
      }) as never
    );
    expect(res.status).toBe(400);
  });

  it("falls back to default starting capital when omitted or invalid", async () => {
    sourceMock.runAndPersistBacktest.mockResolvedValue({
      runId: "run-1",
      result: { summary: {} },
    });
    await postRun(
      makeRequest({
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      }) as never
    );
    const callArgs = sourceMock.runAndPersistBacktest.mock.calls[0][0];
    expect(callArgs.startingCapital).toBeGreaterThan(0);
  });

  it("tolerates an unparseable body (defaults to 400 because dates are required)", async () => {
    const res = await postRun({
      json: async () => {
        throw new Error("bad json");
      },
    } as never);
    expect(res.status).toBe(400);
  });

  it("forwards filters to the source layer (Phase 15b.1)", async () => {
    sourceMock.runAndPersistBacktest.mockResolvedValue({
      runId: "run-1",
      result: { summary: {} },
    });
    await postRun(
      makeRequest({
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        startingCapital: 50_000,
        filters: {
          minScore: 40,
          minAvgDollarVolume: 20_000_000,
          minRiskReward: 2.5,
        },
      }) as never
    );
    const callArgs = sourceMock.runAndPersistBacktest.mock.calls[0][0];
    expect(callArgs.filters).toEqual({
      minScore: 40,
      minAvgDollarVolume: 20_000_000,
      minRiskReward: 2.5,
    });
  });

  it("sanitises filters — drops non-finite + negative values", async () => {
    sourceMock.runAndPersistBacktest.mockResolvedValue({
      runId: "run-1",
      result: { summary: {} },
    });
    await postRun(
      makeRequest({
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        startingCapital: 50_000,
        filters: {
          minScore: 50, // good
          minAvgDollarVolume: -100, // dropped (negative)
          minRiskReward: "bad", // dropped (non-numeric)
        },
      }) as never
    );
    const callArgs = sourceMock.runAndPersistBacktest.mock.calls[0][0];
    expect(callArgs.filters).toEqual({ minScore: 50 });
  });

  it("omits the filters key entirely when all values are invalid/absent", async () => {
    sourceMock.runAndPersistBacktest.mockResolvedValue({
      runId: "run-1",
      result: { summary: {} },
    });
    await postRun(
      makeRequest({
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        startingCapital: 50_000,
        filters: { minScore: NaN, minAvgDollarVolume: -1 },
      }) as never
    );
    const callArgs = sourceMock.runAndPersistBacktest.mock.calls[0][0];
    expect(callArgs.filters).toBeUndefined();
  });

  it("emits an inline error event when the simulator throws", async () => {
    sourceMock.runAndPersistBacktest.mockRejectedValue(new Error("DB down"));
    const res = await postRun(
      makeRequest({
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        startingCapital: 50_000,
      }) as never
    );
    expect(res.status).toBe(200);
    const events = (await readNdjsonStream(res)) as Array<{
      kind: string;
      message?: string;
    }>;
    const errEvent = events.find((e) => e.kind === "error");
    expect(errEvent?.message).toBe("DB down");
    expect(loggerMock.log.error).toHaveBeenCalledWith(
      "api.backtest",
      "run.error",
      expect.any(Object)
    );
  });
});

describe("GET /api/backtest/runs", () => {
  it("returns the list with count", async () => {
    sourceMock.listBacktestRuns.mockResolvedValue([
      { id: "r1", totalReturnPct: 12.5, tradesCount: 42 },
    ]);
    const res = await getRuns();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.runs[0].id).toBe("r1");
  });

  it("returns 500 on source failure", async () => {
    sourceMock.listBacktestRuns.mockRejectedValue(new Error("db down"));
    const res = await getRuns();
    expect(res.status).toBe(500);
    expect(loggerMock.log.error).toHaveBeenCalledWith(
      "api.backtest",
      "runs.error",
      expect.any(Object)
    );
  });
});
