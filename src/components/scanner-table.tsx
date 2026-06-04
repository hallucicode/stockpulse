"use client";

// Phase 14 — compact mode: a real table.
//
// The previous "compact" mode reused the badge-soup StockCard. It had a
// structural layout bug: right column (recommendation, score, badges, vol,
// timestamp) was always much taller than the left (symbol, name, price),
// so the card had dead space between price and the full-width signals row
// at the bottom.
//
// This component replaces that with a proper table — one row per stock,
// rectangular grid, easy to scan 50 names at a time. It complements the
// labelled-row TradeCard (rich detail per stock) rather than competing
// with it.
//
// Columns: Symbol · Sector · Rec · Score · Price · Day % · R:R · Catalysts
//   - Catalysts column shows the count + star confidence, not the chips
//     themselves (the trade card is where the chips live).
//   - R:R is hidden text "—" when no risk packet, so the column doesn't
//     collapse and rows stay aligned.

import { useStore, type ScannerStock } from "@/hooks/use-store";

interface Props {
  stocks: ScannerStock[];
}

function recColor(rec: ScannerStock["analysis"]["recommendation"]): string {
  switch (rec) {
    case "STRONG BUY":
      return "text-emerald-300 font-bold";
    case "BUY":
      return "text-emerald-400";
    case "HOLD":
      return "text-slate-400";
    case "SELL":
      return "text-rose-400";
    case "STRONG SELL":
      return "text-rose-300 font-bold";
  }
}

/**
 * Map a -100..+100 composite score to the same red→yellow→green hue
 * used by `ScoreGauge` in the detailed card, so the two views stay
 * visually consistent.
 */
function scoreColor(score: number): string {
  const clamped = Math.max(-100, Math.min(100, score));
  const normalized = (clamped + 100) / 200; // 0..1
  const hue = normalized * 120; // 0 = red, 60 = yellow, 120 = green
  return `hsl(${hue}, 80%, 55%)`;
}

/** "+62", "0", "-30" — explicit + for positives, native - for negatives. */
function formatSignedScore(score: number): string {
  return `${score > 0 ? "+" : ""}${score.toFixed(0)}`;
}

export function ScannerTable({ stocks }: Props) {
  const { setView, setSelectedSymbol, portfolio } = useStore();
  const ownedSet = new Set(portfolio.map((p) => p.symbol));

  if (stocks.length === 0) {
    return (
      <div className="text-center py-12 text-slate-500">
        <div className="text-2xl mb-2">No stocks found</div>
        <div className="text-sm">Try a different filter or search</div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/[0.06] overflow-hidden">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="bg-white/[0.03] text-slate-500 uppercase tracking-wider text-[9px]">
            <th className="text-left px-2 py-1.5 font-semibold">Sym</th>
            <th className="text-left px-2 py-1.5 font-semibold">Sector</th>
            <th className="text-left px-2 py-1.5 font-semibold">Rec</th>
            <th className="text-right px-2 py-1.5 font-semibold">Score</th>
            <th className="text-right px-2 py-1.5 font-semibold">Price</th>
            <th className="text-right px-2 py-1.5 font-semibold">Day %</th>
            <th className="text-right px-2 py-1.5 font-semibold">R:R</th>
            <th className="text-right px-2 py-1.5 font-semibold">Cat.</th>
          </tr>
        </thead>
        <tbody>
          {stocks.map((stock) => {
            const a = stock.analysis;
            const owned = ownedSet.has(stock.symbol);
            const dayChange = a.dayChange ?? 0;
            const score = a.compositeScore ?? 0;
            const rr = a.risk?.riskReward;
            const catCount = a.catalysts?.confidence ?? 0;
            return (
              <tr
                key={stock.symbol}
                onClick={() => {
                  setSelectedSymbol(stock.symbol);
                  setView("detail");
                }}
                className="border-t border-white/[0.04] hover:bg-white/[0.03] cursor-pointer transition-colors"
              >
                <td className="px-2 py-1.5">
                  <span className="font-extrabold">{stock.symbol}</span>
                  {owned && (
                    <span
                      className="ml-1 inline-block px-1 rounded text-[8px] font-bold bg-cyan-500/15 text-cyan-400 tracking-wider align-middle"
                      title="In portfolio"
                    >
                      ●
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-slate-400">{stock.sector}</td>
                <td className={`px-2 py-1.5 ${recColor(a.recommendation)}`}>
                  {a.recommendation}
                </td>
                <td
                  className="px-2 py-1.5 text-right font-mono font-bold"
                  style={{ color: scoreColor(score) }}
                >
                  {formatSignedScore(score)}
                </td>
                <td className="px-2 py-1.5 text-right font-mono">
                  ${(a.price ?? 0).toFixed(2)}
                </td>
                <td
                  className={`px-2 py-1.5 text-right font-mono ${dayChange >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                >
                  {dayChange >= 0 ? "+" : ""}
                  {dayChange.toFixed(1)}%
                </td>
                <td className="px-2 py-1.5 text-right text-cyan-400 font-mono">
                  {rr && rr > 0 ? `${rr.toFixed(1)}×` : "—"}
                </td>
                <td className="px-2 py-1.5 text-right text-amber-300/90">
                  {catCount > 0 ? "★".repeat(catCount) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
