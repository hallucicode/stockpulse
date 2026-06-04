import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScannerTable } from "@/components/scanner-table";
import { useStore, type ScannerStock } from "@/hooks/use-store";
import type { Analysis } from "@/types";

function makeAnalysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    symbol: "AAA",
    price: 100,
    rsi: 50,
    sma20: 100,
    sma50: 100,
    bollingerUpper: 110,
    bollingerLower: 90,
    bollingerMid: 100,
    macdLine: 0,
    macdSignal: 0,
    macdHistogram: 0,
    dayChange: 1.5,
    weekChange: 0,
    monthChange: 0,
    avgDailyVolatility: 1,
    compositeScore: 42,
    recommendation: "BUY",
    signals: [],
    ...overrides,
  };
}

function makeStock(symbol: string, overrides: Partial<ScannerStock> = {}): ScannerStock {
  return {
    symbol,
    name: `${symbol} Inc`,
    sector: "Technology",
    analysis: makeAnalysis({ symbol, ...overrides.analysis }),
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  useStore.setState({
    view: "scanner",
    selectedSymbol: null,
    portfolio: [],
  });
  vi.clearAllMocks();
});

describe("ScannerTable", () => {
  it("renders the header row with all columns", () => {
    render(<ScannerTable stocks={[makeStock("AAA")]} />);
    for (const header of ["Sym", "Sector", "Rec", "Score", "Price", "Day %", "R:R", "Cat."]) {
      expect(screen.getByText(header)).toBeInTheDocument();
    }
  });

  it("renders one row per stock", () => {
    render(
      <ScannerTable
        stocks={[makeStock("AAA"), makeStock("BBB"), makeStock("CCC")]}
      />
    );
    expect(screen.getByText("AAA")).toBeInTheDocument();
    expect(screen.getByText("BBB")).toBeInTheDocument();
    expect(screen.getByText("CCC")).toBeInTheDocument();
  });

  it("clicking a row navigates to detail view", () => {
    render(<ScannerTable stocks={[makeStock("AAA")]} />);
    fireEvent.click(screen.getByText("AAA"));
    expect(useStore.getState().view).toBe("detail");
    expect(useStore.getState().selectedSymbol).toBe("AAA");
  });

  it("renders an OWNED marker (●) for symbols in the portfolio", () => {
    useStore.setState({
      portfolio: [
        {
          id: "p1",
          symbol: "AAA",
          name: "AAA Inc",
          shares: 5,
          buyPrice: 100,
          buyDate: "2026-01-01",
          currentPrice: 110,
          pl: 50,
          plPct: 10,
          status: "open",
        },
      ],
    });
    render(<ScannerTable stocks={[makeStock("AAA"), makeStock("BBB")]} />);
    // OWNED dot tooltip identifies the marker.
    expect(screen.getAllByTitle("In portfolio").length).toBe(1);
  });

  it("colour-codes recommendations (STRONG BUY emerald, STRONG SELL rose)", () => {
    render(
      <ScannerTable
        stocks={[
          makeStock("AAA", {
            analysis: makeAnalysis({ symbol: "AAA", recommendation: "STRONG BUY" }),
          }),
          makeStock("BBB", {
            analysis: makeAnalysis({ symbol: "BBB", recommendation: "STRONG SELL" }),
          }),
        ]}
      />
    );
    const buy = screen.getByText("STRONG BUY");
    const sell = screen.getByText("STRONG SELL");
    expect(buy.className).toMatch(/emerald/);
    expect(sell.className).toMatch(/rose/);
  });

  it("formats day-change green when positive, rose when negative", () => {
    render(
      <ScannerTable
        stocks={[
          makeStock("AAA", {
            analysis: makeAnalysis({ symbol: "AAA", dayChange: 3.4 }),
          }),
          makeStock("BBB", {
            analysis: makeAnalysis({ symbol: "BBB", dayChange: -2.1 }),
          }),
        ]}
      />
    );
    const up = screen.getByText("+3.4%");
    const down = screen.getByText("-2.1%");
    expect(up.className).toMatch(/emerald/);
    expect(down.className).toMatch(/rose/);
  });

  it("renders R:R from the risk packet or '—' when absent", () => {
    render(
      <ScannerTable
        stocks={[
          makeStock("WITH", {
            analysis: makeAnalysis({
              symbol: "WITH",
              risk: {
                atr: 1,
                entry: 100,
                stop: 90,
                stopMethod: "atr",
                target: 130,
                riskReward: 3.0,
              },
            }),
          }),
          makeStock("WITHOUT", {
            analysis: makeAnalysis({ symbol: "WITHOUT" }),
          }),
        ]}
      />
    );
    expect(screen.getByText("3.0×")).toBeInTheDocument();
    // Both R:R and Catalysts of empty rows render "—" — the empty-state row
    // for WITHOUT should produce at least one of those dashes.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("shows the empty state when there are no stocks", () => {
    render(<ScannerTable stocks={[]} />);
    expect(screen.getByText(/No stocks found/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders catalyst confidence stars in the Cat. column", () => {
    render(
      <ScannerTable
        stocks={[
          makeStock("HOT", {
            analysis: makeAnalysis({
              symbol: "HOT",
              catalysts: {
                score: 25,
                present: ["earnings_upcoming", "insider_cluster", "analyst_upgrade"],
                confidence: 3,
              },
            }),
          }),
        ]}
      />
    );
    expect(screen.getByText("★★★")).toBeInTheDocument();
  });
});
