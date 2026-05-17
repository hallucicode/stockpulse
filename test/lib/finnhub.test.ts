import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { finnhubFetch, getFinnhubKey } from "@/lib/finnhub";

const originalFetch = global.fetch;

beforeEach(() => {
  vi.stubEnv("FINNHUB_API_KEY", "test-key-123");
});

afterEach(() => {
  vi.unstubAllEnvs();
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("getFinnhubKey", () => {
  it("returns the key when env var is set", () => {
    expect(getFinnhubKey()).toBe("test-key-123");
  });

  it("returns undefined when env var is empty", () => {
    vi.stubEnv("FINNHUB_API_KEY", "");
    expect(getFinnhubKey()).toBeUndefined();
  });

  it("returns undefined when env var is unset", () => {
    vi.stubEnv("FINNHUB_API_KEY", undefined as unknown as string);
    expect(getFinnhubKey()).toBeUndefined();
  });
});

describe("finnhubFetch", () => {
  it("returns no_key when API key is unset (and never hits the network)", async () => {
    vi.stubEnv("FINNHUB_API_KEY", "");
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const r = await finnhubFetch("/calendar/earnings");
    expect(r).toEqual({ status: "no_key" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns ok + parsed JSON on a 2xx response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: [{ a: 1 }] }),
    });
    const r = await finnhubFetch<{ data: Array<{ a: number }> }>(
      "/stock/insider-transactions",
      { symbol: "AAPL" }
    );
    expect(r).toEqual({ status: "ok", data: { data: [{ a: 1 }] } });
  });

  it("appends the API key to the URL as a `token` query param", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    global.fetch = fetchSpy;

    await finnhubFetch("/company-news", { symbol: "AAPL", from: "2026-01-01" });

    const calledUrl = fetchSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain("symbol=AAPL");
    expect(calledUrl).toContain("from=2026-01-01");
    expect(calledUrl).toContain("token=test-key-123");
  });

  it("normalises path (works with or without leading slash)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    global.fetch = fetchSpy;

    await finnhubFetch("calendar/earnings", { from: "x" });
    expect(fetchSpy.mock.calls[0][0]).toContain(
      "/api/v1/calendar/earnings?"
    );
  });

  it("returns rate_limited on HTTP 429", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({}),
    });
    const r = await finnhubFetch("/whatever");
    expect(r).toEqual({ status: "rate_limited" });
  });

  it("returns error on other non-2xx HTTP statuses", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    const r = await finnhubFetch("/whatever");
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error).toBe("HTTP 503");
    }
  });

  it("returns error when fetch() throws (network failure)", async () => {
    const err = new Error("ECONNREFUSED");
    global.fetch = vi.fn().mockRejectedValue(err);
    const r = await finnhubFetch("/whatever");
    expect(r.status).toBe("error");
    if (r.status === "error") {
      expect(r.error).toBe(err);
    }
  });

  it("returns error when JSON parsing fails", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new Error("bad json")),
    });
    const r = await finnhubFetch("/whatever");
    expect(r.status).toBe("error");
  });
});
