import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TradeCard } from "@/components/trade-card";
import { useStore, type ScannerStock } from "@/hooks/use-store";
import type { Analysis } from "@/types";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";

function makeAnalysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    symbol: "NVDA",
    price: 432,
    rsi: 45,
    sma20: 430,
    sma50: 420,
    bollingerUpper: 450,
    bollingerLower: 410,
    bollingerMid: 430,
    macdLine: 0.5,
    macdSignal: 0.3,
    macdHistogram: 0.2,
    dayChange: -1.5,
    weekChange: -3,
    monthChange: -8,
    avgDailyVolatility: 2.5,
    compositeScore: 62,
    recommendation: "STRONG BUY",
    signals: [],
    ...overrides,
  };
}

function makeStock(overrides: Partial<ScannerStock> = {}): ScannerStock {
  return {
    symbol: "NVDA",
    name: "NVIDIA Corp",
    sector: "Technology",
    analysis: makeAnalysis(),
    ...overrides,
  };
}

const FULL_ANALYSIS = makeAnalysis({
  risk: {
    atr: 5,
    entry: 432,
    stop: 409,
    stopMethod: "atr",
    target: 503,
    riskReward: 3.0,
  },
  regime: {
    regime: "ranging",
    meanReversionMultiplier: 1,
    momentumMultiplier: 1,
    buyMultiplier: 1,
    sellMultiplier: 1,
  },
  diagnosis: {
    category: "sector_selloff",
    rationale: "Semis -8% week",
    newsCount: 5,
    scoreAdjustment: 0,
  },
  earnings: {
    nextDate: "2026-06-15",
    daysUntil: 12,
    imminent: true,
    hour: "bmo",
  },
  insiders: {
    hasClusterBuy: true,
    clusterBuyerCount: 3,
    recentBuyValueUsd: 450_000,
    lastBuyAt: "2026-05-10T00:00:00Z",
    scoreAdjustment: 5,
  },
  analysts: {
    recentUpgrades: 1,
    recentDowngrades: 0,
    latest: {
      firm: "Morgan Stanley",
      action: "upgraded",
      fromGrade: "Hold",
      toGrade: "Overweight",
      date: "2026-05-12T00:00:00Z",
    },
    scoreAdjustment: 3,
  },
  catalysts: {
    score: 25,
    present: ["earnings_upcoming", "insider_cluster", "analyst_upgrade"],
    confidence: 3,
  },
  options: {
    atmIV: 0.22,
    ivRank: 22,
    putCallRatio: 0.6,
    callVolume: 5000,
    callOpenInterest: 30000,
    putVolume: 3000,
    putOpenInterest: 25000,
    unusualCalls: false,
    unusualPuts: false,
    skew: null,
    scoreAdjustment: 0,
  },
  signals: [
    { label: "RSI Neutral", detail: "RSI 50", type: "neutral", weight: 0 },
    {
      label: "Below Lower Bollinger",
      detail: "Price below band",
      type: "buy",
      weight: 5,
    },
    {
      label: "MACD Bullish",
      detail: "MACD line above signal",
      type: "buy",
      weight: 8,
    },
  ],
});

beforeEach(() => {
  useStore.setState({
    view: "scanner",
    selectedSymbol: null,
    portfolio: [],
  });
  vi.clearAllMocks();
});

describe("TradeCard", () => {
  it("renders the full structured layout when all data is present", () => {
    const stock = makeStock({ analysis: FULL_ANALYSIS });
    render(<TradeCard stock={stock} portfolioValueUsd={50_000} />);
    expect(screen.getByText("NVDA")).toBeInTheDocument();
    expect(screen.getByText("Technology")).toBeInTheDocument();
    expect(screen.getByText(/STRONG BUY/)).toBeInTheDocument();
    expect(screen.getByText(/Regime: ranging/)).toBeInTheDocument();
    // ranging + STRONG BUY = fit ✓
    expect(screen.getByLabelText(/regime fits signal/)).toBeInTheDocument();
    expect(screen.getByText(/sector-wide selloff/i)).toBeInTheDocument();
    // Rich inline catalyst chips:
    //   📅 Earnings 12d BMO · 👥 3 insiders ($450k) · ⬆ Morgan Stanley: Hold→Overweight
    expect(
      screen.getByText(/📅 Earnings 12d BMO/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/👥 3 insiders \(\$450k\)/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/⬆ Morgan Stanley: Hold→Overweight/)
    ).toBeInTheDocument();
    expect(screen.getByText(/IV 22%/)).toBeInTheDocument();
    // Diagnosis row carries the rationale text inline now.
    expect(
      screen.getByText(/🌊 Sector dip — Semis -8% week/)
    ).toBeInTheDocument();
    expect(screen.getByText(/R:R 3.0×/)).toBeInTheDocument();
    // Signals row: top-3 technical signals.
    expect(screen.getByText(/RSI Neutral/)).toBeInTheDocument();
    expect(screen.getByText(/Below Lower Bollinger/)).toBeInTheDocument();
    expect(screen.getByText(/MACD Bullish/)).toBeInTheDocument();
    // Size: capped (NVDA-style tight stop).
    expect(screen.getByText(/shares/)).toBeInTheDocument();
    expect(screen.getByText(/capped/)).toBeInTheDocument();
    expect(screen.getByText("Copy ticket")).toBeInTheDocument();
  });

  it("formats insider value in millions when big enough", () => {
    const stock = makeStock({
      analysis: makeAnalysis({
        insiders: {
          hasClusterBuy: true,
          clusterBuyerCount: 2,
          recentBuyValueUsd: 2_400_000,
          lastBuyAt: "2026-05-10T00:00:00Z",
          scoreAdjustment: 5,
        },
        catalysts: {
          score: 10,
          present: ["insider_cluster"],
          confidence: 1,
        },
      }),
    });
    render(<TradeCard stock={stock} portfolioValueUsd={50_000} />);
    expect(
      screen.getByText(/👥 2 insiders \(\$2.4M\)/)
    ).toBeInTheDocument();
  });

  it("omits the ($) tail when insider value is zero", () => {
    const stock = makeStock({
      analysis: makeAnalysis({
        insiders: {
          hasClusterBuy: true,
          clusterBuyerCount: 2,
          recentBuyValueUsd: 0,
          lastBuyAt: "2026-05-10T00:00:00Z",
          scoreAdjustment: 5,
        },
        catalysts: {
          score: 5,
          present: ["insider_cluster"],
          confidence: 1,
        },
      }),
    });
    render(<TradeCard stock={stock} portfolioValueUsd={50_000} />);
    // Chip ends after the count — no trailing parens.
    expect(screen.getByText(/👥 2 insiders/)).toBeInTheDocument();
    expect(screen.queryByText(/\$0/)).toBeNull();
  });

  it("falls back to analyst action when grade strings are missing", () => {
    const stock = makeStock({
      analysis: makeAnalysis({
        analysts: {
          recentUpgrades: 1,
          recentDowngrades: 0,
          latest: {
            firm: "Goldman Sachs Inc",
            action: "Initiated Buy",
            fromGrade: null,
            toGrade: null,
            date: "2026-05-12T00:00:00Z",
          },
          scoreAdjustment: 3,
        },
        catalysts: {
          score: 5,
          present: ["analyst_upgrade"],
          confidence: 1,
        },
      }),
    });
    render(<TradeCard stock={stock} portfolioValueUsd={50_000} />);
    // "Inc" suffix stripped from firm; action used instead of grades.
    expect(
      screen.getByText(/⬆ Goldman Sachs: Initiated Buy/)
    ).toBeInTheDocument();
  });

  it("renders sector-rotation and FDA chips with their detail", () => {
    const stock = makeStock({
      analysis: makeAnalysis({
        sectorRotation: {
          state: "turning_up",
          etfSymbol: "XLV",
          close: 130,
          sma200: 128,
          recentRunBars: 3,
        },
        fda: {
          hasRecentApproval: true,
          lastApprovalAt: "2026-05-01T00:00:00Z",
          description: "Approval of treatment X",
        },
        catalysts: {
          score: 15,
          present: ["sector_rotation", "fda_event"],
          confidence: 2,
        },
      }),
    });
    render(<TradeCard stock={stock} portfolioValueUsd={50_000} />);
    expect(
      screen.getByText(/🔄 XLV turning up/)
    ).toBeInTheDocument();
    expect(screen.getByText(/💊 FDA approval/)).toBeInTheDocument();
  });

  it("skips catalyst chips whose source data is missing (defensive)", () => {
    // present says insider_cluster but no insiders object → chip dropped.
    const stock = makeStock({
      analysis: makeAnalysis({
        catalysts: {
          score: 5,
          present: ["insider_cluster"],
          confidence: 1,
        },
      }),
    });
    render(<TradeCard stock={stock} portfolioValueUsd={50_000} />);
    // No catalysts row because the only chip was null.
    expect(screen.queryByText(/Catalysts/)).toBeNull();
  });

  it("renders unusual-call and unusual-put markers inline on the options row", () => {
    const stock = makeStock({
      analysis: makeAnalysis({
        options: {
          atmIV: 0.45,
          ivRank: 55,
          putCallRatio: 1.1,
          callVolume: 5000,
          callOpenInterest: 10_000,
          putVolume: 8000,
          putOpenInterest: 12_000,
          unusualCalls: true,
          unusualPuts: true,
          skew: null,
          scoreAdjustment: 0,
        },
      }),
    });
    render(<TradeCard stock={stock} portfolioValueUsd={50_000} />);
    expect(screen.getByText(/⚡ unusual calls/)).toBeInTheDocument();
    expect(screen.getByText(/🛡 unusual puts/)).toBeInTheDocument();
  });

  it("hides the signals row when no signals are present", () => {
    const stock = makeStock({ analysis: makeAnalysis({ signals: [] }) });
    render(<TradeCard stock={stock} portfolioValueUsd={50_000} />);
    expect(screen.queryByText(/^Signals$/)).toBeNull();
  });

  it("hides each row when its data is absent", () => {
    // Bare-bones analysis: no risk, no regime, no diagnosis, no catalysts,
    // no options.
    const stock = makeStock({ analysis: makeAnalysis() });
    render(<TradeCard stock={stock} portfolioValueUsd={50_000} />);
    expect(screen.queryByText(/Why cheap\?/)).toBeNull();
    expect(screen.queryByText(/Catalysts/)).toBeNull();
    expect(screen.queryByText(/Options/)).toBeNull();
    expect(screen.queryByText(/Diagnosis/)).toBeNull();
    expect(screen.queryByText(/Entry\/Stop/)).toBeNull();
    expect(screen.queryByText(/^Size/)).toBeNull();
    expect(screen.queryByText(/Confidence/)).toBeNull();
    // Header + copy button still render.
    expect(screen.getByText("NVDA")).toBeInTheDocument();
    expect(screen.getByText("Copy ticket")).toBeInTheDocument();
  });

  it("shows the ⚠ icon when regime is a headwind", () => {
    const headwindAnalysis = makeAnalysis({
      recommendation: "STRONG BUY",
      regime: {
        regime: "trending_down",
        meanReversionMultiplier: 1,
        momentumMultiplier: 1,
        buyMultiplier: 1,
        sellMultiplier: 1,
      },
    });
    render(
      <TradeCard
        stock={makeStock({ analysis: headwindAnalysis })}
        portfolioValueUsd={50_000}
      />
    );
    expect(screen.getByLabelText(/regime warning/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/regime fits signal/)).toBeNull();
  });

  it("marks the position OWNED when the symbol is in the portfolio", () => {
    useStore.setState({
      portfolio: [
        {
          id: "x",
          symbol: "NVDA",
          name: "NVIDIA",
          shares: 10,
          buyPrice: 400,
          buyDate: "2026-01-01",
          currentPrice: 432,
          pl: 320,
          plPct: 8,
          status: "open",
        },
      ],
    });
    render(<TradeCard stock={makeStock()} portfolioValueUsd={50_000} />);
    expect(screen.getByText("OWNED")).toBeInTheDocument();
  });

  it("clicking the card body navigates to detail view", () => {
    render(<TradeCard stock={makeStock()} portfolioValueUsd={50_000} />);
    fireEvent.click(screen.getByText("NVDA"));
    expect(useStore.getState().view).toBe("detail");
    expect(useStore.getState().selectedSymbol).toBe("NVDA");
  });

  it("clicking Copy ticket writes to the clipboard and does NOT navigate", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });
    const stock = makeStock({ analysis: FULL_ANALYSIS });
    render(<TradeCard stock={stock} portfolioValueUsd={50_000} />);
    fireEvent.click(screen.getByText("Copy ticket"));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(toast.success).toHaveBeenCalledWith("Trade ticket copied");
    });
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toMatch(/NVDA — STRONG BUY/);
    expect(text).toMatch(/Why:.*selloff/i);
    expect(text).toMatch(/Entry \/ Stop \/ Target/);
    expect(text).toMatch(/Size:.*shares/);
    // stopPropagation worked — view did NOT change.
    expect(useStore.getState().view).toBe("scanner");
  });

  it("surfaces a toast.error when clipboard fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <TradeCard
        stock={makeStock({ analysis: FULL_ANALYSIS })}
        portfolioValueUsd={50_000}
      />
    );
    fireEvent.click(screen.getByText("Copy ticket"));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to copy trade ticket");
    });
  });

  it("renders an uncapped Size row (no '(capped)' marker)", () => {
    const stock = makeStock({
      analysis: makeAnalysis({
        risk: {
          atr: 5,
          entry: 50,
          stop: 30,
          stopMethod: "atr",
          target: 110,
          riskReward: 3.0,
        },
      }),
    });
    render(<TradeCard stock={stock} portfolioValueUsd={100_000} />);
    // 50 shares × $50 = $2500 = 2.5% — well under 10% cap.
    expect(screen.getByText(/50 shares/)).toBeInTheDocument();
    expect(screen.queryByText(/capped/)).toBeNull();
  });

  it("hides the Size row when sizing returns null (entry above risk budget)", () => {
    const stock = makeStock({
      analysis: makeAnalysis({
        risk: {
          atr: 5,
          entry: 200,
          stop: 150,
          stopMethod: "atr",
          target: 400,
          riskReward: 4.0,
        },
      }),
    });
    // $1000 portfolio, 1% = $10 risk budget; $50/share risk → 0.2 shares.
    render(<TradeCard stock={stock} portfolioValueUsd={1000} />);
    // Entry row still renders (risk is intact); size row should not.
    expect(screen.getByText(/R:R 4.0×/)).toBeInTheDocument();
    expect(screen.queryByText(/portfolio$/)).toBeNull();
  });

  it("renders the Options line without rank flavour when IV rank is null", () => {
    const stock = makeStock({
      analysis: makeAnalysis({
        options: {
          atmIV: 0.3,
          ivRank: null,
          putCallRatio: null,
          callVolume: 1000,
          callOpenInterest: 5000,
          putVolume: 800,
          putOpenInterest: 4000,
          unusualCalls: false,
          unusualPuts: false,
          skew: null,
          scoreAdjustment: 0,
        },
      }),
    });
    render(<TradeCard stock={stock} portfolioValueUsd={50_000} />);
    expect(screen.getByText(/IV 30%/)).toBeInTheDocument();
    expect(screen.getByText(/rank pending/)).toBeInTheDocument();
  });

  it("renders expensive-IV flavour when rank is above the high percentile", () => {
    const stock = makeStock({
      analysis: makeAnalysis({
        options: {
          atmIV: 0.6,
          ivRank: 95,
          putCallRatio: 1.2,
          callVolume: 1000,
          callOpenInterest: 5000,
          putVolume: 800,
          putOpenInterest: 4000,
          unusualCalls: false,
          unusualPuts: false,
          skew: null,
          scoreAdjustment: 0,
        },
      }),
    });
    render(<TradeCard stock={stock} portfolioValueUsd={50_000} />);
    expect(screen.getByText(/expensive/i)).toBeInTheDocument();
  });

  it("renders neutral-IV (no flavour) when rank is in the middle band", () => {
    const stock = makeStock({
      analysis: makeAnalysis({
        options: {
          atmIV: 0.4,
          ivRank: 50,
          putCallRatio: 1.0,
          callVolume: 1000,
          callOpenInterest: 5000,
          putVolume: 800,
          putOpenInterest: 4000,
          unusualCalls: false,
          unusualPuts: false,
          skew: null,
          scoreAdjustment: 0,
        },
      }),
    });
    render(<TradeCard stock={stock} portfolioValueUsd={50_000} />);
    expect(screen.getByText(/IV 40%/)).toBeInTheDocument();
    expect(screen.queryByText(/cheap|expensive/i)).toBeNull();
  });

  it("hides the Options row when atmIV is null", () => {
    const stock = makeStock({
      analysis: makeAnalysis({
        options: {
          atmIV: null,
          ivRank: null,
          putCallRatio: null,
          callVolume: 0,
          callOpenInterest: 0,
          putVolume: 0,
          putOpenInterest: 0,
          unusualCalls: false,
          unusualPuts: false,
          skew: null,
          scoreAdjustment: 0,
        },
      }),
    });
    render(<TradeCard stock={stock} portfolioValueUsd={50_000} />);
    expect(screen.queryByText(/^Options$/)).toBeNull();
  });

  it("hides the Diagnosis row for technical_only (muted category)", () => {
    const stock = makeStock({
      analysis: makeAnalysis({
        diagnosis: {
          category: "technical_only",
          rationale: "",
          newsCount: 0,
          scoreAdjustment: 0,
        },
      }),
    });
    render(<TradeCard stock={stock} portfolioValueUsd={50_000} />);
    expect(screen.queryByText(/^Diagnosis$/)).toBeNull();
  });
});
