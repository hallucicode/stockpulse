"use client";

import { useStore } from "@/hooks/use-store";
import { useDataFetcher } from "@/hooks/use-data";
import { ScannerView } from "@/components/scanner-view";
import { PortfolioView } from "@/components/portfolio-view";
import { DetailView } from "@/components/detail-view";
import type { Regime } from "@/types";

// Phase 6 — regime pill colour + label.
const REGIME_STYLE: Record<Regime, { bg: string; label: string; emoji: string }> = {
  trending_up: {
    bg: "bg-emerald-500/15 text-emerald-300",
    label: "TRENDING UP",
    emoji: "📈",
  },
  trending_down: {
    bg: "bg-rose-500/15 text-rose-300",
    label: "TRENDING DOWN",
    emoji: "📉",
  },
  ranging: {
    bg: "bg-amber-500/15 text-amber-300",
    label: "RANGING",
    emoji: "↔",
  },
  high_vol_crisis: {
    bg: "bg-rose-500/25 text-rose-300",
    label: "HIGH VOL",
    emoji: "⚠",
  },
};

function RegimePill({ regime }: { regime: Regime | null }) {
  if (!regime) return null;
  const s = REGIME_STYLE[regime];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold tracking-wider ${s.bg}`}
      title={`Market regime: ${s.label}. Signal weights adjusted accordingly.`}
    >
      <span>{s.emoji}</span>
      {s.label}
    </span>
  );
}

export default function HomePage() {
  const { view, setView, portfolio, regime } = useStore();
  useDataFetcher();

  return (
    <div className="max-w-[900px] mx-auto px-4 py-3 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/icon.svg"
            alt=""
            aria-hidden="true"
            style={{ height: 28, width: 28 }}
          />
          <div>
            <h1
              className="text-lg font-extrabold tracking-tight m-0"
              style={{
                background: "linear-gradient(135deg, #22d3ee, #a78bfa)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              StockPulse
            </h1>
            <p className="text-[10px] text-slate-600 tracking-[2px] uppercase m-0">
              {view === "scanner"
                ? "Volatile Stock Scanner"
                : view === "portfolio"
                  ? "Portfolio"
                  : "Stock Detail"}
            </p>
          </div>
        </div>

        {/* Right: nav + market-regime status pill. The regime pill lives here
            (rather than next to the subtitle) so it reads as a global system
            indicator on every view, including the detail page where nav is
            hidden. */}
        <div className="flex items-center gap-3 flex-wrap">
          {view !== "detail" && (
            <nav className="flex gap-1">
              <button
                onClick={() => setView("scanner")}
                className={`px-3.5 py-1.5 rounded-md text-xs font-semibold border-none cursor-pointer transition-all ${
                  view === "scanner"
                    ? "bg-cyan-500/15 text-cyan-400"
                    : "bg-transparent text-slate-500 hover:text-slate-400"
                }`}
              >
                Scanner
              </button>
              <button
                onClick={() => setView("portfolio")}
                className={`px-3.5 py-1.5 rounded-md text-xs font-semibold border-none cursor-pointer transition-all ${
                  view === "portfolio"
                    ? "bg-cyan-500/15 text-cyan-400"
                    : "bg-transparent text-slate-500 hover:text-slate-400"
                }`}
              >
                Portfolio{" "}
                {portfolio.length > 0 && (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full text-[9px] bg-cyan-500/20 text-cyan-400">
                    {portfolio.length}
                  </span>
                )}
              </button>
            </nav>
          )}
          <RegimePill regime={regime} />
        </div>
      </div>

      {/* View Router */}
      {view === "scanner" && <ScannerView />}
      {view === "portfolio" && <PortfolioView />}
      {view === "detail" && <DetailView />}
    </div>
  );
}
