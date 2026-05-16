import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import LogsPage from "@/app/logs/page";

function mockResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

const SAMPLE = {
  entries: [
    {
      id: "1",
      timestamp: new Date().toISOString(),
      level: "error",
      component: "earnings",
      event: "fetch.http-error",
      meta: { status: 401 },
    },
    {
      id: "2",
      timestamp: new Date().toISOString(),
      level: "info",
      component: "fetcher",
      event: "refresh.done",
      meta: { succeeded: 565 },
    },
  ],
  health: [
    {
      component: "fetcher",
      label: "Stock fetcher",
      description: "...",
      lastSuccessAt: new Date().toISOString(),
      lastSuccessAgeSec: 60,
      expectedFreshnessSec: 900,
      refreshIntervalMs: 5 * 60_000,
      recentErrors: 0,
      recentWarnings: 1,
      recentIssues: [],
      status: "ok",
    },
    {
      component: "earnings",
      label: "Earnings calendar",
      description: "...",
      lastSuccessAt: null,
      lastSuccessAgeSec: null,
      expectedFreshnessSec: 108000,
      refreshIntervalMs: 24 * 3600_000,
      recentErrors: 1,
      recentWarnings: 0,
      recentIssues: [],
      status: "failing",
    },
  ],
  components: [
    "analysts",
    "api.logs",
    "earnings",
    "fetcher",
    "fundamentals",
    "insiders",
    "news",
    "regime",
  ],
  total: 2,
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LogsPage", () => {
  it("renders health cards and entries", async () => {
    global.fetch = vi.fn().mockResolvedValue(mockResponse(SAMPLE)) as any;
    render(<LogsPage />);
    await waitFor(() =>
      expect(screen.getByText("Stock fetcher")).toBeInTheDocument()
    );
    expect(screen.getByText("Earnings calendar")).toBeInTheDocument();
    expect(screen.getByText("fetch.http-error")).toBeInTheDocument();
    expect(screen.getByText("refresh.done")).toBeInTheDocument();
  });

  it("shows error banner on fetch failure", async () => {
    global.fetch = vi.fn().mockResolvedValue(mockResponse({}, false)) as any;
    render(<LogsPage />);
    await waitFor(() =>
      expect(screen.getByText(/Failed to load logs/)).toBeInTheDocument()
    );
  });

  it("shows empty state when no entries", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        mockResponse({ entries: [], health: SAMPLE.health, total: 0 })
      ) as any;
    render(<LogsPage />);
    await waitFor(() =>
      expect(screen.getByText("No log entries yet")).toBeInTheDocument()
    );
  });

  it("polls every 15s", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(SAMPLE));
    global.fetch = fetchMock as any;
    render(<LogsPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("filters by level via query string", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(SAMPLE));
    global.fetch = fetchMock as any;
    render(<LogsPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // The default load uses no level filter
    expect(fetchMock.mock.calls[0][0]).not.toContain("level=");
  });

  it("populates the component dropdown from the server-provided list", async () => {
    // Regression: previously the dropdown was derived from `entries[].component`
    // (only ~2 components in the SAMPLE), making the filter incomplete.
    global.fetch = vi.fn().mockResolvedValue(mockResponse(SAMPLE)) as any;
    render(<LogsPage />);
    await waitFor(() => {
      const select = screen.getByLabelText(/Component:/) as HTMLSelectElement;
      const optionTexts = Array.from(select.options).map((o) => o.value);
      expect(optionTexts).toEqual([
        "all",
        "analysts",
        "api.logs",
        "earnings",
        "fetcher",
        "fundamentals",
        "insiders",
        "news",
        "regime",
      ]);
    });
  });

  it("displays each component's refresh cadence on the health card", async () => {
    global.fetch = vi.fn().mockResolvedValue(mockResponse(SAMPLE)) as any;
    render(<LogsPage />);
    await waitFor(() =>
      expect(screen.getByText(/Runs every 5 min/)).toBeInTheDocument()
    );
    // 24h gets promoted to "1 day" by the formatter.
    expect(screen.getByText(/Runs every 1 day/)).toBeInTheDocument();
  });

  it("displays recent error/warn counts in the health card", async () => {
    global.fetch = vi.fn().mockResolvedValue(mockResponse(SAMPLE)) as any;
    render(<LogsPage />);
    await waitFor(() =>
      expect(screen.getByText("1 error")).toBeInTheDocument()
    );
    expect(screen.getByText("1 warn")).toBeInTheDocument();
  });

  it("renders meta details with key=value formatting", async () => {
    global.fetch = vi.fn().mockResolvedValue(mockResponse(SAMPLE)) as any;
    render(<LogsPage />);
    await waitFor(() =>
      expect(screen.getByText(/status=401/)).toBeInTheDocument()
    );
    expect(screen.getByText(/succeeded=565/)).toBeInTheDocument();
  });
});
