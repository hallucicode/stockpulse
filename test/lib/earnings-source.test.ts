import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const dbMock: any = {
  earningsEvent: { upsert: vi.fn(), findMany: vi.fn() },
};
vi.mock("@/lib/db", () => ({ db: dbMock }));

beforeEach(() => {
  vi.resetModules();
  dbMock.earningsEvent.upsert = vi.fn().mockResolvedValue({});
  dbMock.earningsEvent.findMany = vi.fn().mockResolvedValue([]);
  process.env.FINNHUB_API_KEY = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchEarningsCalendar", () => {
  it("returns [] and does not call fetch when key missing", async () => {
    delete process.env.FINNHUB_API_KEY;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;

    const mod = await import("@/lib/earnings-source");
    const r = await mod.fetchEarningsCalendar(new Date(), new Date());
    expect(r).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns rows when Finnhub responds 200", async () => {
    process.env.FINNHUB_API_KEY = "key123";
    const rows = [
      { symbol: "AAPL", date: "2026-04-30", epsEstimate: 1.5, hour: "amc" },
    ];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ earningsCalendar: rows }),
    }) as any;

    const mod = await import("@/lib/earnings-source");
    const r = await mod.fetchEarningsCalendar(
      new Date("2026-04-27"),
      new Date("2026-05-05")
    );
    expect(r).toEqual(rows);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("token=key123")
    );
  });

  it("returns [] on HTTP error", async () => {
    process.env.FINNHUB_API_KEY = "k";
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 }) as any;
    const mod = await import("@/lib/earnings-source");
    const r = await mod.fetchEarningsCalendar(new Date(), new Date());
    expect(r).toEqual([]);
  });

  it("returns [] on network failure", async () => {
    process.env.FINNHUB_API_KEY = "k";
    global.fetch = vi.fn().mockRejectedValue(new Error("net down")) as any;
    const mod = await import("@/lib/earnings-source");
    const r = await mod.fetchEarningsCalendar(new Date(), new Date());
    expect(r).toEqual([]);
  });

  it("treats missing earningsCalendar key as empty", async () => {
    process.env.FINNHUB_API_KEY = "k";
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({}) }) as any;
    const mod = await import("@/lib/earnings-source");
    const r = await mod.fetchEarningsCalendar(new Date(), new Date());
    expect(r).toEqual([]);
  });
});

describe("refreshEarningsCalendar", () => {
  it("returns 0 and skips upserts when no key", async () => {
    delete process.env.FINNHUB_API_KEY;
    const mod = await import("@/lib/earnings-source");
    const n = await mod.refreshEarningsCalendar();
    expect(n).toBe(0);
    expect(dbMock.earningsEvent.upsert).not.toHaveBeenCalled();
  });

  it("upserts each valid row", async () => {
    process.env.FINNHUB_API_KEY = "k";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          { symbol: "AAPL", date: "2026-04-30", epsEstimate: 1.5, hour: "amc" },
          { symbol: "MSFT", date: "2026-05-01", epsEstimate: null, hour: null },
        ],
      }),
    }) as any;

    const mod = await import("@/lib/earnings-source");
    const n = await mod.refreshEarningsCalendar();
    expect(n).toBe(2);
    expect(dbMock.earningsEvent.upsert).toHaveBeenCalledTimes(2);
  });

  it("skips rows with missing symbol or date and bad dates", async () => {
    process.env.FINNHUB_API_KEY = "k";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          { symbol: "", date: "2026-04-30" },
          { symbol: "AAA", date: "" },
          { symbol: "BBB", date: "not-a-date" },
          { symbol: "CCC", date: "2026-05-01" },
        ],
      }),
    }) as any;

    const mod = await import("@/lib/earnings-source");
    const n = await mod.refreshEarningsCalendar();
    expect(n).toBe(1);
  });

  it("survives a single upsert failure", async () => {
    process.env.FINNHUB_API_KEY = "k";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          { symbol: "A", date: "2026-04-30" },
          { symbol: "B", date: "2026-05-01" },
        ],
      }),
    }) as any;
    dbMock.earningsEvent.upsert
      .mockRejectedValueOnce(new Error("write fail"))
      .mockResolvedValueOnce({});

    const mod = await import("@/lib/earnings-source");
    const n = await mod.refreshEarningsCalendar();
    expect(n).toBe(1);
  });

  it("returns 0 when calendar is empty", async () => {
    process.env.FINNHUB_API_KEY = "k";
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ earningsCalendar: [] }),
    }) as any;

    const mod = await import("@/lib/earnings-source");
    const n = await mod.refreshEarningsCalendar();
    expect(n).toBe(0);
    expect(dbMock.earningsEvent.upsert).not.toHaveBeenCalled();
  });
});

describe("getNextEarningsForSymbol", () => {
  it("returns null when DB has no rows", async () => {
    dbMock.earningsEvent.findMany.mockResolvedValue([]);
    const mod = await import("@/lib/earnings-source");
    const r = await mod.getNextEarningsForSymbol("AAPL", new Date("2026-04-27"));
    expect(r).toBeNull();
  });

  it("returns the next event from DB", async () => {
    dbMock.earningsEvent.findMany.mockResolvedValue([
      { symbol: "AAPL", date: new Date("2026-04-30"), epsEstimate: 1.5, hour: "amc" },
    ]);
    const mod = await import("@/lib/earnings-source");
    const r = await mod.getNextEarningsForSymbol("AAPL", new Date("2026-04-27"));
    expect(r?.nextDate).toBe("2026-04-30");
    expect(r?.imminent).toBe(true);
    expect(r?.epsEstimate).toBe(1.5);
  });

  it("uses default `now` when not provided", async () => {
    dbMock.earningsEvent.findMany.mockResolvedValue([]);
    const mod = await import("@/lib/earnings-source");
    const r = await mod.getNextEarningsForSymbol("AAPL");
    expect(r).toBeNull();
  });
});
