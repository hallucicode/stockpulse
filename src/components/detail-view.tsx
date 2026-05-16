"use client";

import { useState, useEffect } from "react";
import { useStore } from "@/hooks/use-store";
import { executeBuy, executeSell } from "@/hooks/use-data";
import { ScoreGauge, SignalBadge } from "./indicators";
import { log } from "@/lib/logger";
import { toast } from "sonner";

interface NewsItemDto {
  id: string;
  headline: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string;
}

function timeAgoShort(iso: string, now = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * News section for the detail view. Fetches /api/news/[symbol] on mount,
 * shows a list of headlines with source + date + link out. Mirrors the
 * diagnosis label up top so the user sees *why* the classifier picked the
 * category alongside the actual evidence.
 */
function NewsSection({ symbol, diagnosisRationale }: {
  symbol: string;
  diagnosisRationale?: string;
}) {
  const [items, setItems] = useState<NewsItemDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError(null);
    fetch(`/api/news/${encodeURIComponent(symbol)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        setItems(data.items as NewsItemDto[]);
      })
      .catch((err) => {
        if (cancelled) return;
        log.warn("detail-view", "news.fetch.failure", {
          symbol,
          error: err instanceof Error ? err.message : String(err),
        });
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  return (
    <div className="bg-[var(--bg-card)] rounded-xl p-3.5 border border-white/5 mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-bold text-slate-400 tracking-wider">
          RECENT NEWS
        </div>
        {items && (
          <div className="text-[10px] text-slate-600">
            {items.length} {items.length === 1 ? "item" : "items"}
          </div>
        )}
      </div>
      {diagnosisRationale && (
        <div className="text-[11px] text-slate-400 mb-2 italic">
          {diagnosisRationale}
        </div>
      )}
      {items === null && !error && (
        <div className="text-[11px] text-slate-600 py-3">Loading news…</div>
      )}
      {error && (
        <div className="text-[11px] text-rose-400 py-2">
          Couldn&apos;t load news: {error}
        </div>
      )}
      {items && items.length === 0 && (
        <div className="text-[11px] text-slate-600 py-3">
          No news in the last 30 days for this symbol. The technical signal is
          standalone.
        </div>
      )}
      {items && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((n) => (
            <li
              key={n.id}
              className="border-t border-white/5 first:border-t-0 pt-2 first:pt-0"
            >
              <a
                href={n.url || undefined}
                target="_blank"
                rel="noopener noreferrer"
                className={`block text-[12px] leading-snug ${
                  n.url
                    ? "text-slate-200 hover:text-cyan-300 cursor-pointer"
                    : "text-slate-300"
                }`}
              >
                {n.headline}
              </a>
              <div className="text-[10px] text-slate-500 mt-0.5">
                {n.source ? `${n.source} · ` : ""}
                {timeAgoShort(n.publishedAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DetailView() {
  const {
    selectedSymbol,
    scannerData,
    portfolio,
    setView,
    setPortfolio,
  } = useStore();
  const [buying, setBuying] = useState(false);

  const stock = scannerData.find((s) => s.symbol === selectedSymbol);
  if (!stock || !selectedSymbol) {
    return (
      <div className="text-center py-12 text-slate-500">
        <div className="text-xl mb-2">Stock not found</div>
        <button
          onClick={() => setView("scanner")}
          className="text-cyan-400 text-sm cursor-pointer bg-transparent border-none"
        >
          ← Back to Scanner
        </button>
      </div>
    );
  }

  const { analysis: a } = stock;
  const owned = portfolio.filter((p) => p.symbol === selectedSymbol);
  const suggestedShares = Math.max(1, Math.floor(1000 / a.price));

  const recColor =
    a.compositeScore >= 40
      ? "text-emerald-400"
      : a.compositeScore >= 15
        ? "text-emerald-300"
        : a.compositeScore > -15
          ? "text-amber-400"
          : a.compositeScore > -40
            ? "text-orange-400"
            : "text-rose-400";

  const handleBuy = async () => {
    setBuying(true);
    try {
      await executeBuy(selectedSymbol, suggestedShares, a.price);
      toast.success(`Bought ${suggestedShares} shares of ${selectedSymbol}`);
      // Refresh portfolio
      const res = await fetch("/api/portfolio");
      if (res.ok) setPortfolio(await res.json());
    } catch (err) {
      log.warn("detail-view", "buy.failure", {
        symbol: selectedSymbol,
        error: err,
      });
      toast.error("Failed to buy");
    } finally {
      setBuying(false);
    }
  };

  const handleSellAll = async () => {
    try {
      for (const pos of owned) {
        await executeSell(pos.id);
      }
      setPortfolio(portfolio.filter((p) => p.symbol !== selectedSymbol));
      toast.success(`Sold all ${selectedSymbol} positions`);
    } catch (err) {
      log.warn("detail-view", "sell-all.failure", {
        symbol: selectedSymbol,
        error: err,
      });
      toast.error("Failed to sell");
    }
  };

  return (
    <div className="animate-fade-in">
      {/* Back button */}
      <button
        onClick={() => setView(owned.length > 0 ? "portfolio" : "scanner")}
        className="mb-4 px-2.5 py-1 rounded-md text-[11px] bg-transparent border border-white/10 text-slate-400 cursor-pointer hover:text-slate-300 transition-colors"
      >
        ← Back
      </button>

      {/* Header */}
      <div className="flex justify-between items-start flex-wrap gap-2 mb-4">
        <div>
          <div className="text-[22px] font-extrabold">{stock.symbol}</div>
          <div className="text-xs text-slate-500">
            {stock.name} ·{" "}
            <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-500/10 text-purple-400">
              {stock.sector}
            </span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-extrabold">${a.price.toFixed(2)}</div>
          <div
            className={`text-sm font-bold ${a.dayChange >= 0 ? "text-emerald-400" : "text-rose-400"}`}
          >
            {a.dayChange >= 0 ? "+" : ""}
            {a.dayChange.toFixed(1)}% today
          </div>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-2 mb-4">
        {[
          { label: "1W Change", value: a.weekChange, isPct: true },
          { label: "1M Change", value: a.monthChange, isPct: true },
          { label: "Avg Daily Vol", value: a.avgDailyVolatility, isPct: false },
        ].map(({ label, value, isPct }) => (
          <div
            key={label}
            className="bg-[var(--bg-card)] rounded-lg p-2 text-center"
          >
            <div className="text-[10px] text-slate-600 mb-0.5">{label}</div>
            <div
              className={`text-[15px] font-bold ${
                !isPct
                  ? "text-purple-400"
                  : value >= 0
                    ? "text-emerald-400"
                    : "text-rose-400"
              }`}
            >
              {!isPct
                ? `${value.toFixed(1)}%`
                : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`}
            </div>
          </div>
        ))}
      </div>

      {/* Analysis card */}
      <div className="bg-[var(--bg-card)] rounded-xl p-3.5 border border-white/5 mb-4">
        <div className="flex justify-between items-center mb-2.5">
          <span className={`text-sm font-bold ${recColor}`}>
            {a.recommendation}
          </span>
          <ScoreGauge score={a.compositeScore} />
        </div>

        <div className="flex flex-wrap mb-2">
          {a.signals.map((s, i) => (
            <SignalBadge key={i} type={s.type} label={s.label} />
          ))}
        </div>

        <div className="space-y-1">
          {a.signals.map((s, i) => (
            <div key={i} className="text-[11px] text-slate-400">
              <span
                className={
                  s.type === "buy"
                    ? "text-emerald-400"
                    : s.type === "sell"
                      ? "text-rose-400"
                      : "text-slate-600"
                }
              >
                ●
              </span>{" "}
              {s.detail}
            </div>
          ))}
        </div>
      </div>

      {/* News + diagnosis (Phase 4 detail view) */}
      <NewsSection
        symbol={selectedSymbol}
        diagnosisRationale={a.diagnosis?.rationale}
      />

      {/* Technical indicators */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="bg-[var(--bg-card)] rounded-lg p-2.5">
          <div className="text-[10px] text-slate-600 mb-1">RSI (14)</div>
          <div
            className={`text-base font-bold ${
              a.rsi < 30
                ? "text-emerald-400"
                : a.rsi > 70
                  ? "text-rose-400"
                  : "text-amber-400"
            }`}
          >
            {a.rsi.toFixed(0)}
          </div>
        </div>
        <div className="bg-[var(--bg-card)] rounded-lg p-2.5">
          <div className="text-[10px] text-slate-600 mb-1">Bollinger</div>
          <div className="text-xs font-semibold">
            {a.price <= a.bollingerLower
              ? "At Lower Band"
              : a.price >= a.bollingerUpper
                ? "At Upper Band"
                : "Mid Range"}
          </div>
        </div>
        <div className="bg-[var(--bg-card)] rounded-lg p-2.5">
          <div className="text-[10px] text-slate-600 mb-1">SMA 20 / 50</div>
          <div className="text-xs font-semibold">
            ${a.sma20.toFixed(2)} / ${a.sma50.toFixed(2)}
          </div>
        </div>
        <div className="bg-[var(--bg-card)] rounded-lg p-2.5">
          <div className="text-[10px] text-slate-600 mb-1">MACD</div>
          <div
            className={`text-xs font-semibold ${a.macdHistogram > 0 ? "text-emerald-400" : "text-rose-400"}`}
          >
            {a.macdHistogram > 0 ? "Bullish" : "Bearish"} (
            {a.macdHistogram.toFixed(2)})
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2 mb-4">
        {a.compositeScore >= 10 && (
          <button
            onClick={handleBuy}
            disabled={buying}
            className="flex-1 px-4 py-2.5 rounded-lg bg-gradient-to-r from-emerald-700 to-emerald-500 text-white text-xs font-bold border-none cursor-pointer hover:from-emerald-600 hover:to-emerald-400 transition-all disabled:opacity-50"
          >
            {buying
              ? "Buying..."
              : `Buy ~${suggestedShares} shares (~$${(suggestedShares * a.price).toFixed(0)})`}
          </button>
        )}
        {owned.length > 0 && (
          <button
            onClick={handleSellAll}
            className="flex-1 px-4 py-2.5 rounded-lg bg-gradient-to-r from-rose-700 to-rose-500 text-white text-xs font-bold border-none cursor-pointer hover:from-rose-600 hover:to-rose-400 transition-all"
          >
            Sell All {stock.symbol}
          </button>
        )}
      </div>

      {/* Owned positions */}
      {owned.length > 0 && (
        <div>
          <div className="text-xs font-bold text-slate-500 mb-2 tracking-wider">
            YOUR POSITIONS
          </div>
          {owned.map((pos) => (
            <div
              key={pos.id}
              className="bg-[var(--bg-card)] rounded-xl p-3 border border-white/5 mb-2 flex justify-between items-center"
            >
              <div>
                <div className="text-xs font-semibold">
                  {pos.shares} shares @ ${pos.buyPrice.toFixed(2)}
                </div>
                <div className="text-[10px] text-slate-600">
                  {new Date(pos.buyDate).toLocaleDateString()}
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                <div className="text-right">
                  <div
                    className={`text-sm font-bold ${pos.pl >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                  >
                    {pos.pl >= 0 ? "+" : "-"}${Math.abs(pos.pl).toFixed(2)}
                  </div>
                  <div
                    className={`text-[10px] ${pos.plPct >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                  >
                    ({pos.plPct >= 0 ? "+" : ""}
                    {pos.plPct.toFixed(1)}%)
                  </div>
                </div>
                <button
                  onClick={() => {
                    executeSell(pos.id).then(() => {
                      setPortfolio(
                        portfolio.filter((p) => p.id !== pos.id)
                      );
                      toast.success("Position closed");
                    });
                  }}
                  className="px-2.5 py-1 rounded-md text-[11px] font-semibold bg-rose-500/10 border border-rose-500/30 text-rose-400 cursor-pointer hover:bg-rose-500/20 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
