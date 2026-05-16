import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useDataFetcher, executeBuy, executeSell, executeRemove } from "@/hooks/use-data";
import { useStore } from "@/hooks/use-store";

function mockResponse(json: any, ok = true) {
  return { ok, json: async () => json };
}

describe("useDataFetcher", () => {
  beforeEach(() => {
    useStore.setState({
      view: "scanner",
      scannerData: [],
      scannerLoading: true,
      scannerLastUpdated: null,
      portfolio: [],
      portfolioLoading: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fetches scanner & portfolio on mount, populates store", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/scanner") {
        return Promise.resolve(
          mockResponse({ stocks: [{ symbol: "A" }], lastUpdated: "T" })
        );
      }
      return Promise.resolve(mockResponse([{ id: "p1" }]));
    });
    global.fetch = fetchMock as any;

    renderHook(() => useDataFetcher());
    await waitFor(() => {
      expect(useStore.getState().scannerData.length).toBe(1);
      expect(useStore.getState().portfolio.length).toBe(1);
    });
    expect(useStore.getState().scannerLastUpdated).toBe("T");
  });

  it("handles legacy array shape from scanner", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/scanner")
        return Promise.resolve(mockResponse([{ symbol: "Z" }]));
      return Promise.resolve(mockResponse([]));
    });
    global.fetch = fetchMock as any;

    renderHook(() => useDataFetcher());
    await waitFor(() => {
      expect(useStore.getState().scannerData.length).toBe(1);
    });
  });

  it("handles non-ok responses by stopping loading and logs warning", async () => {
    const { setLoggerSink, resetLoggerSink } = await import("@/lib/logger");
    const sink = vi.fn();
    setLoggerSink(sink);

    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    global.fetch = fetchMock as any;

    renderHook(() => useDataFetcher());
    await waitFor(() => {
      expect(useStore.getState().scannerLoading).toBe(false);
      expect(useStore.getState().portfolioLoading).toBe(false);
    });
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn" })
    );
    resetLoggerSink();
  });

  it("polls every 30s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/scanner")
        return Promise.resolve(mockResponse({ stocks: [] }));
      return Promise.resolve(mockResponse([]));
    });
    global.fetch = fetchMock as any;

    renderHook(() => useDataFetcher());
    // Initial 2 fetches (scanner + portfolio)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
  });
});

describe("trade actions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("executeBuy posts to /api/trade and returns json", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ id: "p" }) });
    global.fetch = fetchMock as any;
    const r = await executeBuy("AAA", 1, 10);
    expect(r).toEqual({ id: "p" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/trade");
    expect(JSON.parse(init.body).action).toBe("buy");
  });

  it("executeBuy throws on non-ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false }) as any;
    await expect(executeBuy("X", 1, 1)).rejects.toThrow("Buy failed");
  });

  it("executeSell sends sell action", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    global.fetch = fetchMock as any;
    const r = await executeSell("p1");
    expect(r).toEqual({ ok: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).action).toBe("sell");
  });

  it("executeSell throws on non-ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false }) as any;
    await expect(executeSell("p")).rejects.toThrow("Sell failed");
  });

  it("executeRemove sends remove action", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    global.fetch = fetchMock as any;
    const r = await executeRemove("p2");
    expect(r).toEqual({ ok: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).action).toBe("remove");
  });

  it("executeRemove throws on non-ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false }) as any;
    await expect(executeRemove("p")).rejects.toThrow("Remove failed");
  });
});
