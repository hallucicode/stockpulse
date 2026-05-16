import { create } from "zustand";
import type { Analysis, PositionWithPL, Regime } from "@/types";

export interface NewsHealth {
  lastIngestAt: string | null;
  ageHours: number | null;
  isStale: boolean;
  isMissing: boolean;
}

export interface ScannerStock {
  symbol: string;
  name: string;
  sector: string;
  analysis: Analysis;
  fetchedAt?: string;
}

interface AppState {
  // View
  view: "scanner" | "portfolio" | "detail";
  setView: (v: "scanner" | "portfolio" | "detail") => void;

  // Scanner
  scannerData: ScannerStock[];
  scannerLoading: boolean;
  scannerLastUpdated: string | null;
  newsHealth: NewsHealth | null;
  regime: Regime | null;
  /** Count of stocks excluded by the quality gate (penny/illiquid/no-earnings/etc). */
  vetoedCount: number;
  setScannerData: (
    data: ScannerStock[],
    lastUpdated?: string | null,
    newsHealth?: NewsHealth | null,
    regime?: Regime | null,
    vetoedCount?: number
  ) => void;
  setScannerLoading: (v: boolean) => void;
  sortBy: "score" | "dayChange" | "volatility";
  setSortBy: (v: "score" | "dayChange" | "volatility") => void;
  sectorFilter: string;
  setSectorFilter: (v: string) => void;

  // Detail
  selectedSymbol: string | null;
  setSelectedSymbol: (sym: string | null) => void;

  // Portfolio
  portfolio: PositionWithPL[];
  portfolioLoading: boolean;
  setPortfolio: (data: PositionWithPL[]) => void;
  setPortfolioLoading: (v: boolean) => void;
}

export const useStore = create<AppState>((set) => ({
  view: "scanner",
  setView: (v) => set({ view: v }),

  scannerData: [],
  scannerLoading: true,
  scannerLastUpdated: null,
  newsHealth: null,
  regime: null,
  vetoedCount: 0,
  setScannerData: (data, lastUpdated, newsHealth, regime, vetoedCount) =>
    set({
      scannerData: data,
      scannerLoading: false,
      scannerLastUpdated: lastUpdated ?? null,
      newsHealth: newsHealth ?? null,
      regime: regime ?? null,
      vetoedCount: vetoedCount ?? 0,
    }),
  setScannerLoading: (v) => set({ scannerLoading: v }),
  sortBy: "score",
  setSortBy: (v) => set({ sortBy: v }),
  sectorFilter: "All",
  setSectorFilter: (v) => set({ sectorFilter: v }),

  selectedSymbol: null,
  setSelectedSymbol: (sym) => set({ selectedSymbol: sym }),

  portfolio: [],
  portfolioLoading: true,
  setPortfolio: (data) => set({ portfolio: data, portfolioLoading: false }),
  setPortfolioLoading: (v) => set({ portfolioLoading: v }),
}));
