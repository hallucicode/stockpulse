"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/hooks/use-store";
import { executeRemove, executeSell } from "@/hooks/use-data";
import { ScoreGauge } from "./indicators";
import { log } from "@/lib/logger";
import { toast } from "sonner";

interface Box3EstimateResponse {
  kind: "ok" | "no-fx-rate";
  asOf?: string;
  valuation?: {
    usdEurRate: number;
    totalValueUsd: number;
    totalValueEur: number;
    fallbackCount: number;
  };
  estimate?: {
    totalValueEur: number;
    heffingsvrijVermogen: number;
    taxableBaseEur: number;
    deemedReturnEur: number;
    estimatedTaxEur: number;
    taxYear: number;
  };
}

function formatEur(n: number): string {
  return n.toLocaleString("nl-NL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function Box3Panel() {
  const [data, setData] = useState<Box3EstimateResponse | null>(null);
  const [snapshotting, setSnapshotting] = useState(false);

  const fetchEstimate = async () => {
    try {
      const res = await fetch("/api/box3/estimate", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Box3EstimateResponse;
      setData(body);
    } catch (err) {
      log.warn("portfolio-view", "box3.fetch.failure", { error: err });
    }
  };

  useEffect(() => {
    fetchEstimate();
  }, []);

  const handleSnapshot = async () => {
    setSnapshotting(true);
    try {
      const res = await fetch("/api/box3/snapshot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: `Manual snapshot ${new Date().toISOString().slice(0, 10)}`,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success("Snapshot saved for Box 3 records.");
      await fetchEstimate();
    } catch (err) {
      log.warn("portfolio-view", "box3.snapshot.failure", { error: err });
      toast.error("Failed to take Box 3 snapshot.");
    } finally {
      setSnapshotting(false);
    }
  };

  if (!data) return null;

  if (data.kind === "no-fx-rate") {
    return (
      <div className="bg-amber-500/[0.06] border border-amber-500/20 rounded-lg p-3 mb-3">
        <div className="text-[11px] text-amber-300 font-semibold mb-0.5">
          📊 Box 3 helper
        </div>
        <div className="text-[10px] text-slate-400">
          USD/EUR rate not yet cached — the daily fx.refresh cron hasn&apos;t
          run yet. Box 3 estimate will appear once it does.
        </div>
      </div>
    );
  }

  if (!data.valuation || !data.estimate) return null;
  const v = data.valuation;
  const e = data.estimate;

  return (
    <div className="bg-[var(--bg-card)] border border-white/5 rounded-lg p-3 mb-3">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-[11px] text-slate-400 font-semibold">
            📊 Box 3 helper · tax year {e.taxYear}
          </div>
          <div className="text-[9px] text-slate-600 italic">
            Estimate — not tax advice. Rates may be out of date; review
            BOX3_CONFIG before filing.
          </div>
        </div>
        <button
          onClick={handleSnapshot}
          disabled={snapshotting}
          className="px-3 py-1 rounded-md text-[11px] font-semibold bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 cursor-pointer hover:bg-cyan-500/20 transition-colors disabled:opacity-50"
        >
          {snapshotting ? "Saving…" : "Snapshot for Box 3"}
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-white/[0.02] rounded p-2">
          <div className="text-[9px] text-slate-500 uppercase tracking-wider">
            Portfolio (USD)
          </div>
          <div className="text-[14px] font-bold">
            $
            {v.totalValueUsd.toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </div>
        </div>
        <div className="bg-white/[0.02] rounded p-2">
          <div className="text-[9px] text-slate-500 uppercase tracking-wider">
            Portfolio (EUR)
          </div>
          <div className="text-[14px] font-bold">
            €{formatEur(v.totalValueEur)}
          </div>
          <div className="text-[9px] text-slate-600">
            @ {v.usdEurRate.toFixed(4)} USD/EUR
          </div>
        </div>
        <div className="bg-white/[0.02] rounded p-2">
          <div className="text-[9px] text-slate-500 uppercase tracking-wider">
            Box 3 estimate
          </div>
          <div className="text-[14px] font-bold text-amber-300">
            €{formatEur(e.estimatedTaxEur)}
          </div>
          {e.taxableBaseEur === 0 && (
            <div className="text-[9px] text-slate-600">below heffingsvrij</div>
          )}
        </div>
      </div>
      {v.fallbackCount > 0 && (
        <div className="text-[9px] text-slate-500 mt-1.5">
          ⚠ {v.fallbackCount} position{v.fallbackCount === 1 ? "" : "s"} used a
          stale buy-price (no recent quote in cache).
        </div>
      )}
    </div>
  );
}

export function PortfolioView() {
  const { portfolio, portfolioLoading, setView, setSelectedSymbol, setPortfolio } =
    useStore();

  const totalValue = portfolio.reduce(
    (sum, p) => sum + p.currentPrice * p.shares,
    0
  );
  const totalCost = portfolio.reduce(
    (sum, p) => sum + p.buyPrice * p.shares,
    0
  );
  const totalPL = totalValue - totalCost;
  const totalPLPct = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;

  const handleSell = async (id: string, symbol: string) => {
    try {
      await executeSell(id);
      setPortfolio(portfolio.filter((p) => p.id !== id));
      toast.success(`Sold ${symbol} position`);
    } catch (err) {
      log.warn("portfolio-view", "sell.failure", { id, symbol, error: err });
      toast.error("Failed to sell position");
    }
  };

  const handleRemove = async (id: string, symbol: string) => {
    try {
      await executeRemove(id);
      setPortfolio(portfolio.filter((p) => p.id !== id));
      toast.success(`Removed ${symbol} from portfolio`);
    } catch (err) {
      log.warn("portfolio-view", "remove.failure", { id, symbol, error: err });
      toast.error("Failed to remove position");
    }
  };

  if (portfolioLoading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-xl p-3.5 bg-[var(--bg-card)] border border-white/5">
            <div className="skeleton w-full h-16" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      {/* Phase 13 — Box 3 helper panel (top of page) */}
      <Box3Panel />

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        <div className="bg-[var(--bg-card)] rounded-lg p-2.5 text-center">
          <div className="text-[10px] text-slate-500">Total Value</div>
          <div className="text-[17px] font-extrabold">
            ${totalValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="bg-[var(--bg-card)] rounded-lg p-2.5 text-center">
          <div className="text-[10px] text-slate-500">Total P&L</div>
          <div
            className={`text-[17px] font-extrabold ${totalPL >= 0 ? "text-emerald-400" : "text-rose-400"}`}
          >
            {totalPL >= 0 ? "+" : "-"}$
            {Math.abs(totalPL).toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </div>
        </div>
        <div className="bg-[var(--bg-card)] rounded-lg p-2.5 text-center">
          <div className="text-[10px] text-slate-500">Return</div>
          <div
            className={`text-[17px] font-extrabold ${totalPLPct >= 0 ? "text-emerald-400" : "text-rose-400"}`}
          >
            {totalPLPct >= 0 ? "+" : ""}
            {totalPLPct.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Empty state */}
      {portfolio.length === 0 ? (
        <div className="text-center py-12 text-slate-500">
          <div className="text-3xl mb-2">No positions yet</div>
          <div className="text-sm mb-4">
            Go to the Scanner to find buy opportunities
          </div>
          <button
            onClick={() => setView("scanner")}
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-emerald-600 to-emerald-500 text-white text-sm font-bold border-none cursor-pointer"
          >
            Open Scanner
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {portfolio.map((p) => (
            <div
              key={p.id}
              className="stock-card rounded-xl p-3.5 bg-[var(--bg-card)] animate-fade-in cursor-pointer"
              onClick={() => {
                setSelectedSymbol(p.symbol);
                setView("detail");
              }}
            >
              <div className="flex justify-between items-start">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[15px] font-extrabold">
                      {p.symbol}
                    </span>
                    <span className="text-[10px] text-slate-500">
                      {p.shares} shares
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-600">
                    Bought @ ${p.buyPrice.toFixed(2)} · Now $
                    {p.currentPrice.toFixed(2)}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className={`text-sm font-extrabold ${p.pl >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                  >
                    {p.pl >= 0 ? "+" : "-"}$
                    {Math.abs(p.pl).toFixed(2)}
                  </div>
                  <div
                    className={`text-[11px] ${p.plPct >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                  >
                    {p.plPct >= 0 ? "+" : ""}
                    {p.plPct.toFixed(1)}%
                  </div>
                </div>
              </div>

              {/* Sell signal alert */}
              {p.sellSignal && (
                <div className="mt-2 flex justify-between items-center bg-rose-500/[0.08] rounded-md px-2.5 py-1.5">
                  <div className="text-[11px] text-rose-400 font-semibold">
                    {p.sellSignal.urgency === "high" ? "🚨" : "⚠️"}{" "}
                    {p.sellSignal.reason}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSell(p.id, p.symbol);
                    }}
                    className="px-3 py-1 rounded-md text-[11px] font-semibold bg-rose-500/10 border border-rose-500/30 text-rose-400 cursor-pointer hover:bg-rose-500/20 transition-colors"
                  >
                    Sell
                  </button>
                </div>
              )}

              {/* Normal state — remove button */}
              {!p.sellSignal && (
                <div className="mt-2 flex justify-between items-center">
                  <div />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemove(p.id, p.symbol);
                    }}
                    className="px-3 py-1 rounded-md text-[11px] font-semibold bg-white/[0.03] border border-white/10 text-slate-400 cursor-pointer hover:bg-white/[0.06] hover:text-slate-300 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
