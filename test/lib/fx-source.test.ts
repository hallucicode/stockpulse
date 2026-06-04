import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { dbMock, loggerMock } = vi.hoisted(() => ({
  dbMock: {
    fxRate: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
    },
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
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/logger", () => loggerMock);

import {
  getLatestUsdEurRate,
  refreshUsdEurRate,
} from "@/lib/fx-source";

const originalFetch = global.fetch;

function mockFetchResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  dbMock.fxRate.upsert = vi.fn().mockResolvedValue({});
  dbMock.fxRate.findFirst = vi.fn().mockResolvedValue(null);
  loggerMock.log.info = vi.fn();
  loggerMock.log.warn = vi.fn();
  loggerMock.log.error = vi.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("refreshUsdEurRate — happy path", () => {
  it("fetches Frankfurter, upserts the row, returns the rate", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        amount: 1,
        base: "USD",
        date: "2026-05-16",
        rates: { EUR: 0.9215 },
      })
    );

    const rate = await refreshUsdEurRate();

    expect(rate).toBe(0.9215);
    expect(dbMock.fxRate.upsert).toHaveBeenCalledTimes(1);
    const args = dbMock.fxRate.upsert.mock.calls[0][0];
    expect(args.create).toMatchObject({
      fromCurrency: "USD",
      toCurrency: "EUR",
      rate: 0.9215,
    });
    expect(args.create.date).toBeInstanceOf(Date);
    expect((args.create.date as Date).toISOString()).toBe(
      "2026-05-16T00:00:00.000Z"
    );
    expect(loggerMock.log.info).toHaveBeenCalledWith(
      "fx",
      "refresh.done",
      expect.objectContaining({ rate: 0.9215 })
    );
  });

  it("calls Frankfurter with the configured currency pair", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      mockFetchResponse({
        amount: 1,
        base: "USD",
        date: "2026-05-16",
        rates: { EUR: 0.9 },
      })
    );
    global.fetch = fetchSpy;
    await refreshUsdEurRate();
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("from=USD");
    expect(url).toContain("to=EUR");
  });
});

describe("refreshUsdEurRate — robustness", () => {
  it("returns null and warns on network failure (no upsert)", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await refreshUsdEurRate()).toBeNull();
    expect(dbMock.fxRate.upsert).not.toHaveBeenCalled();
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "fx",
      "fetch.network-error",
      expect.any(Object)
    );
  });

  it("returns null and warns on HTTP 5xx", async () => {
    global.fetch = vi.fn().mockResolvedValue(mockFetchResponse({}, 503));
    expect(await refreshUsdEurRate()).toBeNull();
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "fx",
      "fetch.http-error",
      expect.objectContaining({ status: 503 })
    );
  });

  it("returns null and warns when JSON parse fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new Error("bad json")),
    } as unknown as Response);
    expect(await refreshUsdEurRate()).toBeNull();
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "fx",
      "fetch.parse-error",
      expect.any(Object)
    );
  });

  it("returns null and warns when response is missing rates field", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({ amount: 1, base: "USD", date: "2026-05-16" })
    );
    expect(await refreshUsdEurRate()).toBeNull();
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "fx",
      "fetch.malformed",
      expect.any(Object)
    );
  });

  it("returns null and warns when rate value is non-finite", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        amount: 1,
        base: "USD",
        date: "2026-05-16",
        rates: { EUR: Number.NaN },
      })
    );
    expect(await refreshUsdEurRate()).toBeNull();
  });

  it("returns null and warns when date is malformed", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        amount: 1,
        base: "USD",
        date: "not-a-date",
        rates: { EUR: 0.92 },
      })
    );
    expect(await refreshUsdEurRate()).toBeNull();
  });

  it("returns null when persist fails (DB error)", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      mockFetchResponse({
        amount: 1,
        base: "USD",
        date: "2026-05-16",
        rates: { EUR: 0.9 },
      })
    );
    dbMock.fxRate.upsert.mockRejectedValue(new Error("db down"));
    expect(await refreshUsdEurRate()).toBeNull();
    expect(loggerMock.log.warn).toHaveBeenCalledWith(
      "fx",
      "persist.failure",
      expect.any(Object)
    );
  });
});

describe("getLatestUsdEurRate", () => {
  it("returns null on cold start (no rows persisted)", async () => {
    dbMock.fxRate.findFirst.mockResolvedValue(null);
    expect(await getLatestUsdEurRate()).toBeNull();
  });

  it("returns the most recent row mapped to { rate, date }", async () => {
    const t = new Date("2026-05-16T00:00:00Z");
    dbMock.fxRate.findFirst.mockResolvedValue({ rate: 0.9215, date: t });
    expect(await getLatestUsdEurRate()).toEqual({ rate: 0.9215, date: t });
  });

  it("queries with the configured currency pair and date-desc ordering", async () => {
    await getLatestUsdEurRate();
    const args = dbMock.fxRate.findFirst.mock.calls[0][0];
    expect(args.where).toEqual({
      fromCurrency: "USD",
      toCurrency: "EUR",
    });
    expect(args.orderBy).toEqual({ date: "desc" });
  });
});
