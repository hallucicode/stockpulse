import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PortfolioView } from "@/components/portfolio-view";
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
