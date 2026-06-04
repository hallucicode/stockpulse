import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Box3Panel, PortfolioView } from "@/components/portfolio-view";
import { useStore } from "@/hooks/use-store";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/use-data", () => ({
  executeBuy: vi.fn(),
  executeSell: vi.fn(),
  executeRemove: vi.fn(),
}));

import { executeSell, executeRemove } from "@/hooks/use-data";

function makePos(id: string, overrides: any = {}) {
  return {
    id,
    symbol: id.toUpperCase(),
    name: id,
    shares: 10,
    buyPrice: 100,
    buyDate: "2026-01-01T00:00:00Z",
    currentPrice: 110,
    pl: 100,
    plPct: 10,
    status: "open" as const,
    ...overrides,
  };
}

describe("Box3Panel", () => {
  const okResponse = {
    kind: "ok" as const,
    asOf: "2026-05-16T00:00:00Z",
    valuation: {
      usdEurRate: 0.92,
      totalValueUsd: 200_000,
      totalValueEur: 184_000,
      fallbackCount: 0,
    },
    estimate: {
      totalValueEur: 184_000,
      heffingsvrijVermogen: 57_000,
      taxableBaseEur: 127_000,
      deemedReturnRate: 0.0604,
      deemedReturnEur: 7670.8,
      taxRate: 0.36,
      estimatedTaxEur: 2761.49,
      taxYear: 2026,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a full Box 3 estimate panel after fetching", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => okResponse,
    }) as unknown as typeof fetch;

    render(<Box3Panel />);
    await waitFor(() => {
      expect(screen.getByText(/Box 3 helper/)).toBeInTheDocument();
    });
    expect(screen.getByText(/tax year 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Estimate — not tax advice/)).toBeInTheDocument();
    expect(screen.getByText(/\$200,000.00/)).toBeInTheDocument();
    expect(screen.getByText(/Snapshot for Box 3/)).toBeInTheDocument();
  });

  it("shows a 'rate not yet cached' state when kind is no-fx-rate", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ kind: "no-fx-rate" }),
    }) as unknown as typeof fetch;

    render(<Box3Panel />);
    await waitFor(() => {
      expect(
        screen.getByText(/USD\/EUR rate not yet cached/)
      ).toBeInTheDocument();
    });
  });

  it("renders nothing when the API call fails (no UI noise)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const { container } = render(<Box3Panel />);
    // Give the effect a tick to settle, then verify nothing rendered.
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });
    expect(container.querySelector("button")).toBeNull();
  });

  it("posts a snapshot when the button is clicked", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => okResponse })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "snap1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => okResponse });
    global.fetch = fetchSpy as unknown as typeof fetch;

    render(<Box3Panel />);
    const button = await waitFor(() => screen.getByText(/Snapshot for Box 3/));
    fireEvent.click(button);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/box3/snapshot",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

  it("shows a fallback warning when some positions used stale buy-prices", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...okResponse,
        valuation: { ...okResponse.valuation, fallbackCount: 2 },
      }),
    }) as unknown as typeof fetch;

    render(<Box3Panel />);
    await waitFor(() => {
      expect(
        screen.getByText(/2 positions used a stale buy-price/)
      ).toBeInTheDocument();
    });
  });

  it("shows 'below heffingsvrij' note when the taxable base is zero", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...okResponse,
        estimate: {
          ...okResponse.estimate,
          taxableBaseEur: 0,
          estimatedTaxEur: 0,
        },
      }),
    }) as unknown as typeof fetch;

    render(<Box3Panel />);
    await waitFor(() => {
      expect(screen.getByText(/below heffingsvrij/)).toBeInTheDocument();
    });
  });
});

describe("PortfolioView", () => {
  beforeEach(() => {
    useStore.setState({
      portfolio: [],
      portfolioLoading: false,
      view: "portfolio",
      selectedSymbol: null,
    });
    vi.clearAllMocks();
  });

  it("shows skeletons when loading", () => {
    useStore.setState({ portfolioLoading: true });
    const { container } = render(<PortfolioView />);
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  it("shows empty state with link to scanner", () => {
    render(<PortfolioView />);
    expect(screen.getByText("No positions yet")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Open Scanner"));
    expect(useStore.getState().view).toBe("scanner");
  });

  it("renders positive PL summary", () => {
    useStore.setState({ portfolio: [makePos("a")] });
    render(<PortfolioView />);
    expect(screen.getByText(/Total Value/)).toBeInTheDocument();
    expect(screen.getByText("Remove")).toBeInTheDocument();
  });

  it("renders negative PL summary", () => {
    useStore.setState({
      portfolio: [makePos("a", { currentPrice: 50, pl: -500, plPct: -50 })],
    });
    render(<PortfolioView />);
    expect(screen.getAllByText(/-50.0%/).length).toBeGreaterThan(0);
  });

  it("clicking a position card opens detail view", () => {
    useStore.setState({ portfolio: [makePos("a")] });
    render(<PortfolioView />);
    fireEvent.click(screen.getByText("A"));
    expect(useStore.getState().view).toBe("detail");
    expect(useStore.getState().selectedSymbol).toBe("A");
  });

  it("Remove button calls executeRemove and updates portfolio", async () => {
    (executeRemove as any).mockResolvedValue({});
    useStore.setState({ portfolio: [makePos("a")] });
    render(<PortfolioView />);
    fireEvent.click(screen.getByText("Remove"));
    await waitFor(() => {
      expect(executeRemove).toHaveBeenCalledWith("a");
      expect(useStore.getState().portfolio.length).toBe(0);
    });
  });

  it("Remove handles error", async () => {
    (executeRemove as any).mockRejectedValue(new Error("fail"));
    useStore.setState({ portfolio: [makePos("a")] });
    render(<PortfolioView />);
    fireEvent.click(screen.getByText("Remove"));
    await waitFor(() => {
      expect(executeRemove).toHaveBeenCalled();
    });
  });

  it("Sell button on sell signal triggers executeSell (high urgency)", async () => {
    (executeSell as any).mockResolvedValue({});
    useStore.setState({
      portfolio: [
        makePos("a", {
          sellSignal: { reason: "down", urgency: "high" as const },
        }),
      ],
    });
    render(<PortfolioView />);
    expect(screen.getByText(/down/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Sell"));
    await waitFor(() => {
      expect(executeSell).toHaveBeenCalledWith("a");
    });
  });

  it("Sell button (medium urgency) error path", async () => {
    (executeSell as any).mockRejectedValue(new Error("nope"));
    useStore.setState({
      portfolio: [
        makePos("a", {
          sellSignal: { reason: "warn", urgency: "medium" as const },
        }),
      ],
    });
    render(<PortfolioView />);
    fireEvent.click(screen.getByText("Sell"));
    await waitFor(() => expect(executeSell).toHaveBeenCalled());
  });
});
