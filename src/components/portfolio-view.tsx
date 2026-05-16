"use client";

import { useStore } from "@/hooks/use-store";
import { executeRemove, executeSell } from "@/hooks/use-data";
import { ScoreGauge } from "./indicators";
import { log } from "@/lib/logger";
import { toast } from "sonner";

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
