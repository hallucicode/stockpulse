"use client";

import { useState, useMemo, useEffect } from "react";
import { useStore, type ScannerStock } from "@/hooks/use-store";
import { Sparkline } from "./sparkline";
import { ScoreGauge, SignalBadge, RecommendationBadge } from "./indicators";
import { TradeCard } from "./trade-card";
import type {
  CatalystInfo,
  CatalystType,
  DiagnosisInfo,
  DiagnosisCategory,
  OptionsActivity,
} from "@/types";
import { CATALYST_CONFIG, OPTIONS_CONFIG, RISK_CONFIG } from "@/lib/config";

// Phase 14 — persist the chosen layout across sessions so the user doesn't
// have to re-pick on every page load. SSR-safe: we read localStorage in a
// useEffect, not during render.
type ViewMode = "detailed" | "compact";
const VIEW_MODE_STORAGE_KEY = "scanner-view-mode";

function useViewMode(): [ViewMode, (next: ViewMode) => void] {
  // Default to detailed — the new Phase 14 card is the recommended layout.
  const [mode, setMode] = useState<ViewMode>("detailed");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
      if (stored === "compact" || stored === "detailed") {
        setMode(stored);
      }
    } catch {
      // localStorage can throw in private-mode / sandboxed contexts — just
      // fall back to the default. Not an error worth logging.
    }
  }, []);
  const update = (next: ViewMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, next);
    } catch {
      // Same fallback: silently accept the in-memory change.
    }
  };
  return [mode, update];
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function useNow(intervalMs = 15_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const PAGE_SIZE = 50;

// Phase 4 — small chip describing why a stock is moving (per news classification).
// Bg/text colour encodes severity; the rationale lives in the tooltip.
const DIAGNOSIS_STYLE: Record<DiagnosisCategory, { bg: string; label: string; emoji: string }> = {
  // Severe negatives — strong red
  fraud: { bg: "bg-rose-500/20 text-rose-300", label: "FRAUD", emoji: "🚨" },
  guidance_cut: { bg: "bg-rose-500/15 text-rose-300", label: "GUIDANCE CUT", emoji: "📉" },
  lawsuit: { bg: "bg-rose-500/15 text-rose-300", label: "LAWSUIT", emoji: "⚖️" },
  regulatory_setback: { bg: "bg-rose-500/15 text-rose-300", label: "REG. SETBACK", emoji: "🛑" },
  dividend_cut: { bg: "bg-rose-500/15 text-rose-300", label: "DIV. CUT", emoji: "✂️" },
  earnings_miss: { bg: "bg-amber-500/15 text-amber-300", label: "EARNINGS MISS", emoji: "💔" },
  // Moderate negatives — amber
  analyst_downgrade: { bg: "bg-amber-500/15 text-amber-300", label: "DOWNGRADE", emoji: "⬇️" },
  layoffs: { bg: "bg-amber-500/15 text-amber-300", label: "LAYOFFS", emoji: "👋" },
  // Neutral — violet/grey
  leadership_change: { bg: "bg-violet-500/15 text-violet-300", label: "LEADERSHIP", emoji: "👤" },
  merger: { bg: "bg-violet-500/15 text-violet-300", label: "M&A", emoji: "🔀" },
  // Mild positives — cyan
  buyback: { bg: "bg-cyan-500/15 text-cyan-300", label: "BUYBACK", emoji: "♻️" },
  dividend_hike: { bg: "bg-cyan-500/15 text-cyan-300", label: "DIV. HIKE", emoji: "💵" },
  partnership: { bg: "bg-cyan-500/15 text-cyan-300", label: "PARTNERSHIP", emoji: "🤝" },
  product_launch: { bg: "bg-emerald-500/15 text-emerald-300", label: "LAUNCH", emoji: "🚀" },
  sector_selloff: { bg: "bg-cyan-500/15 text-cyan-300", label: "SECTOR DIP", emoji: "🌊" },
  // Strong positives — emerald
  earnings_beat: { bg: "bg-emerald-500/15 text-emerald-300", label: "EARNINGS BEAT", emoji: "💚" },
  analyst_upgrade: { bg: "bg-emerald-500/15 text-emerald-300", label: "UPGRADE", emoji: "⬆️" },
  regulatory_approval: { bg: "bg-emerald-500/15 text-emerald-300", label: "APPROVED", emoji: "✅" },
  // Informational — intentionally muted. Tells the user "we saw news but
  // it's not a catalyst", not "we couldn't read it".
  earnings_report: { bg: "bg-slate-500/15 text-slate-300", label: "EARNINGS", emoji: "📊" },
  market_wrap: { bg: "bg-slate-500/10 text-slate-400", label: "WRAP", emoji: "📰" },
  // Defaults
  technical_only: { bg: "", label: "", emoji: "" }, // never rendered
  unknown: { bg: "bg-slate-500/15 text-slate-300", label: "NEWS", emoji: "📰" },
};

function DiagnosisBadge({ diagnosis }: { diagnosis: DiagnosisInfo }) {
  const style = DIAGNOSIS_STYLE[diagnosis.category];
  if (!style.label) return null;
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider ${style.bg}`}
      title={diagnosis.rationale}
    >
      {style.emoji} {style.label}
    </span>
  );
}

// Phase 7 — human-readable label per catalyst type, used in the tooltip.
// Lives outside the component so adding a new CatalystType is a single-line
// change here + the matching entry in CATALYST_CONFIG.weights.
const CATALYST_LABEL: Record<CatalystType, string> = {
  earnings_upcoming: "Upcoming earnings (≤30d)",
  insider_cluster: "Cluster insider buying",
  analyst_upgrade: "Recent analyst upgrade",
  positive_news: "Positive news catalyst",
  sector_rotation: "Sector turning up after downtrend",
  fda_event: "Recent FDA drug approval",
};

function ConfidenceStars({ catalysts }: { catalysts: CatalystInfo }) {
  if (catalysts.confidence === 0) return null;
  const filled = Math.min(catalysts.confidence, CATALYST_CONFIG.maxStars);
  const empty = Math.max(0, CATALYST_CONFIG.maxStars - filled);
  const tooltip = [
    `${filled} catalyst${filled === 1 ? "" : "s"}:`,
    ...catalysts.present.map((c) => `  • ${CATALYST_LABEL[c]}`),
  ].join("\n");
  return (
    <span
      // `aria-label` mirrors the tooltip so screen readers + tests see the same
      // information without depending on hover.
      aria-label={tooltip}
      title={tooltip}
      className="text-[10px] tracking-wider font-bold text-amber-300/90 select-none"
    >
      <span className="text-amber-300">{"★".repeat(filled)}</span>
      <span className="text-slate-600">{"☆".repeat(empty)}</span>
    </span>
  );
}

function OptionsLine({ options }: { options: OptionsActivity }) {
  if (options.atmIV === null) return null;
  const ivPct = options.atmIV * 100;
  // Color the rank: low = cheap (green), high = expensive (amber), else
  // neutral. Only colour when the rank is actually meaningful (non-null).
  const rankClass =
    options.ivRank === null
      ? "text-slate-500"
      : options.ivRank < OPTIONS_CONFIG.ivRankLowPercentile
        ? "text-emerald-300"
        : options.ivRank > OPTIONS_CONFIG.ivRankHighPercentile
          ? "text-amber-300"
          : "text-slate-400";
  const rankLabel =
    options.ivRank === null
      ? "rank pending"
      : `rank ${options.ivRank.toFixed(0)}`;
  const pcr =
    options.putCallRatio === null
      ? ""
      : ` · P/C ${options.putCallRatio.toFixed(2)}`;
  return (
    <div
      className={`text-[10px] ${rankClass}`}
      title={`ATM IV ${ivPct.toFixed(1)}% (${rankLabel}). Call vol ${options.callVolume.toLocaleString()} / OI ${options.callOpenInterest.toLocaleString()} · Put vol ${options.putVolume.toLocaleString()} / OI ${options.putOpenInterest.toLocaleString()}`}
    >
      IV {ivPct.toFixed(0)}% ({rankLabel}){pcr}
    </div>
  );
}

function StockCard({ stock }: { stock: ScannerStock }) {
  const { setView, setSelectedSymbol, portfolio } = useStore();
  const { analysis: a } = stock;
  const owned = portfolio.some((p) => p.symbol === stock.symbol);

  // We don't have raw close history on the client side from API
  // In production, you'd include sparkline data in the scanner response
  // For now we show the key metrics

  return (
    <div
      className="stock-card rounded-xl p-3.5 bg-[var(--bg-card)] cursor-pointer animate-fade-in"
      onClick={() => {
        setSelectedSymbol(stock.symbol);
        setView("detail");
      }}
    >
      <div className="flex justify-between items-start">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[15px] font-extrabold">{stock.symbol}</span>
            <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-500/10 text-purple-400 tracking-wider">
              {stock.sector}
            </span>
            {owned && (
              <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold bg-cyan-500/15 text-cyan-400 tracking-wider">
                OWNED
              </span>
            )}
          </div>
          <div className="text-[11px] text-slate-500 mb-1.5 truncate">
            {stock.name}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-base font-extrabold">
              ${(a.price ?? 0).toFixed(2)}
            </span>
            <span
              className={`text-xs font-bold ${(a.dayChange ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}
            >
              {(a.dayChange ?? 0) >= 0 ? "+" : ""}
              {(a.dayChange ?? 0).toFixed(1)}%
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            <RecommendationBadge
              recommendation={a.recommendation}
              score={a.compositeScore ?? 0}
            />
            <ScoreGauge score={a.compositeScore ?? 0} />
          </div>
          {/* Phase 7: confidence stars — count of independent catalysts
              (earnings/insiders/upgrade/news) that back the technical
              signal. Hidden when zero so flat names don't get noise. */}
          {a.catalysts && a.catalysts.confidence > 0 && (
            <ConfidenceStars catalysts={a.catalysts} />
          )}
          {/* Phase 3: imminent-earnings warning. Only shown when within the
              imminence window — distant events don't deserve UI noise. */}
          {a.earnings?.imminent && (
            <span
              className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/15 text-amber-300 tracking-wider"
              title={`Reports on ${a.earnings.nextDate}${a.earnings.hour ? ` (${a.earnings.hour})` : ""}`}
            >
              📅 EARNINGS IN {a.earnings.daysUntil}D
            </span>
          )}
          {/* Phase 4: news diagnosis. Hidden for technical_only — that's the
              "no news, no badge" default. Coloured by severity. */}
          {a.diagnosis &&
            a.diagnosis.category !== "technical_only" && (
              <DiagnosisBadge diagnosis={a.diagnosis} />
          )}
          {/* Phase 5: cluster insider buy badge — strongest single signal. */}
          {a.insiders?.hasClusterBuy && (
            <span
              className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/20 text-emerald-300 tracking-wider"
              title={`${a.insiders.clusterBuyerCount} insiders bought (last 14 days)${a.insiders.recentBuyValueUsd > 0 ? ` · ~$${(a.insiders.recentBuyValueUsd / 1000).toFixed(0)}k value` : ""}`}
            >
              👥 INSIDER BUYS ({a.insiders.clusterBuyerCount})
            </span>
          )}
          {/* Phase 5: analyst rating actions — direction-coloured. */}
          {a.analysts?.latest && a.analysts.scoreAdjustment !== 0 && (
            <span
              className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider ${
                a.analysts.scoreAdjustment > 0
                  ? "bg-emerald-500/15 text-emerald-300"
                  : a.analysts.scoreAdjustment < 0
                    ? "bg-rose-500/15 text-rose-300"
                    : "bg-slate-500/15 text-slate-300"
              }`}
              title={`${a.analysts.latest.firm}: ${a.analysts.latest.fromGrade ?? "?"} → ${a.analysts.latest.toGrade ?? "?"} (${new Date(a.analysts.latest.date).toLocaleDateString()})`}
            >
              {a.analysts.scoreAdjustment > 0 ? "⬆ UPGRADED" : "⬇ DOWNGRADED"}
            </span>
          )}
          {/* Phase 8: unusual options flow badges. Hidden unless flow
              triggered the OPTIONS_CONFIG ratio. Tooltips give the
              underlying numbers so a click isn't required to see why. */}
          {a.options?.unusualCalls && (
            <span
              className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/15 text-emerald-300 tracking-wider"
              title={`Call volume ${a.options.callVolume.toLocaleString()} vs OI ${a.options.callOpenInterest.toLocaleString()}`}
            >
              📞 UNUSUAL CALLS
            </span>
          )}
          {a.options?.unusualPuts && (
            <span
              className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold bg-rose-500/15 text-rose-300 tracking-wider"
              title={`Put volume ${a.options.putVolume.toLocaleString()} vs OI ${a.options.putOpenInterest.toLocaleString()}`}
            >
              🛡 UNUSUAL PUTS
            </span>
          )}
          {/* Phase 8: IV / IV-rank / P/C line. Hidden when no options
              chain exists for this symbol. */}
          {a.options && <OptionsLine options={a.options} />}
          <div className="text-[10px] text-slate-600">
            Vol: {(a.avgDailyVolatility ?? 0).toFixed(1)}%/day
          </div>
          {stock.fetchedAt && (
            <div className="text-[9px] text-slate-700">
              Updated {timeAgo(stock.fetchedAt)}
            </div>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap">
        {a.signals.slice(0, 3).map((s, i) => (
          <SignalBadge key={i} type={s.type} label={s.label} />
        ))}
      </div>

      {/* Phase 1: stop / target / R:R. Hidden when no risk packet (older
          cache entries) or degenerate values (zero or negative R:R). */}
      {a.risk && a.risk.entry > 0 && a.risk.riskReward > 0 && (
        <div className="mt-2 flex items-center gap-3 text-[10px] text-slate-500">
          <span>
            Stop:{" "}
            <span className="text-rose-400 font-semibold">
              ${a.risk.stop.toFixed(2)}
            </span>
          </span>
          <span>
            Target:{" "}
            <span className="text-emerald-400 font-semibold">
              ${a.risk.target.toFixed(2)}
            </span>
          </span>
          <span>
            R:R{" "}
            <span className="text-cyan-400 font-semibold">
              {a.risk.riskReward.toFixed(1)}×
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-xl p-3.5 bg-[var(--bg-card)] border border-white/5">
      <div className="flex justify-between">
        <div>
          <div className="skeleton w-16 h-5 mb-2" />
          <div className="skeleton w-32 h-3 mb-3" />
          <div className="skeleton w-20 h-5" />
        </div>
        <div className="skeleton w-24 h-8" />
      </div>
      <div className="flex gap-1 mt-3">
        <div className="skeleton w-20 h-5" />
        <div className="skeleton w-24 h-5" />
      </div>
    </div>
  );
}

function NewsHealthBanner() {
  const { newsHealth } = useStore();
  if (!newsHealth) return null;
  if (!newsHealth.isStale && !newsHealth.isMissing) return null;
  const message = newsHealth.isMissing
    ? "News data unavailable — diagnosis filter (lawsuit / earnings miss / etc.) is blank for every stock until the next refresh succeeds. Check /logs for the cause."
    : `News data is ${newsHealth.ageHours}h old (threshold ${24}h). Diagnoses may be stale; the API likely got rate-limited or is failing. See /logs.`;
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 mb-3 text-amber-200 text-xs">
      <span className="font-bold mr-1">⚠ News data warning:</span>
      {message}
    </div>
  );
}

export function ScannerView() {
  const {
    scannerData,
    scannerLoading,
    sortBy,
    setSortBy,
    sectorFilter,
    setSectorFilter,
    vetoedCount,
    portfolio,
  } = useStore();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useViewMode();
  useNow(); // re-renders every 15s so timeAgo stays live

  // Phase 14 — TradeCard needs the portfolio total to compute sizing. Empty
  // portfolio falls back to RISK_CONFIG.defaultPortfolioValue so the user
  // gets a representative example before they own anything.
  const portfolioValueUsd = useMemo(() => {
    if (portfolio.length === 0) return RISK_CONFIG.defaultPortfolioValue;
    return portfolio.reduce((sum, p) => sum + p.currentPrice * p.shares, 0);
  }, [portfolio]);

  const sectors = useMemo(
    () => ["All", ...new Set(scannerData.map((s) => s.sector))].sort(),
    [scannerData]
  );

  const filtered = useMemo(() => {
    let result = scannerData;
    if (sectorFilter !== "All") {
      result = result.filter((s) => s.sector === sectorFilter);
    }
    if (search.trim()) {
      const q = search.trim().toUpperCase();
      result = result.filter(
        (s) =>
          s.symbol.includes(q) || s.name.toUpperCase().includes(q)
      );
    }
    return result;
  }, [scannerData, sectorFilter, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (sortBy === "score")
        return (b.analysis.compositeScore ?? 0) - (a.analysis.compositeScore ?? 0);
      if (sortBy === "dayChange")
        return (b.analysis.dayChange ?? 0) - (a.analysis.dayChange ?? 0);
      return (b.analysis.avgDailyVolatility ?? 0) - (a.analysis.avgDailyVolatility ?? 0);
    });
  }, [filtered, sortBy]);

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE);
  const paged = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Reset page when filters change
  const resetPage = () => setPage(0);

  const sortOptions: { key: typeof sortBy; label: string }[] = [
    { key: "score", label: "Best Signal" },
    { key: "dayChange", label: "Top Movers" },
    { key: "volatility", label: "Most Volatile" },
  ];

  return (
    <div>
      {/* Status bar — tracked = total monitored (visible + filtered out by
          the quality gate); filtered = vetoed by Phase 2.5 / 4.5 rules;
          shown = after the user's sector/search filter. */}
      <div className="text-[10px] text-slate-500 mb-2.5">
        {scannerLoading
          ? "Loading stocks..."
          : `${scannerData.length + vetoedCount} tracked · ${vetoedCount} filtered out · ${filtered.length} shown`}
      </div>

      <NewsHealthBanner />

      {/* Search */}
      <input
        type="text"
        placeholder="Search symbol or name..."
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          resetPage();
        }}
        className="w-full mb-2.5 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs text-slate-300 placeholder-slate-600 outline-none focus:border-cyan-500/30"
      />

      {/* Sector filter */}
      <div className="flex gap-1.5 mb-2.5 flex-wrap">
        {sectors.map((s) => (
          <button
            key={s}
            onClick={() => {
              setSectorFilter(s);
              resetPage();
            }}
            className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border-none cursor-pointer transition-all ${
              sectorFilter === s
                ? "bg-purple-500/20 text-purple-400"
                : "bg-white/[0.03] text-slate-500 hover:text-slate-400"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Sort options + view-mode toggle */}
      <div className="flex gap-1.5 mb-3 items-center">
        {sortOptions.map((opt) => (
          <button
            key={opt.key}
            onClick={() => {
              setSortBy(opt.key);
              resetPage();
            }}
            className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border-none cursor-pointer transition-all ${
              sortBy === opt.key
                ? "bg-cyan-500/15 text-cyan-400"
                : "bg-white/[0.03] text-slate-500 hover:text-slate-400"
            }`}
          >
            {opt.label}
          </button>
        ))}
        <div className="flex-1" />
        {/* Phase 14 — layout toggle. localStorage-persisted via useViewMode. */}
        <button
          onClick={() =>
            setViewMode(viewMode === "detailed" ? "compact" : "detailed")
          }
          aria-label="Toggle scanner view mode"
          title={
            viewMode === "detailed"
              ? "Switch to compact list"
              : "Switch to detailed trade cards"
          }
          className="px-2.5 py-1 rounded-full text-[10px] font-semibold border-none cursor-pointer transition-all bg-white/[0.03] text-slate-500 hover:text-slate-400"
        >
          {viewMode === "detailed" ? "Compact" : "Detailed"}
        </button>
      </div>

      {/* Stock cards */}
      <div className="flex flex-col gap-2">
        {scannerLoading ? (
          Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
        ) : paged.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <div className="text-2xl mb-2">No stocks found</div>
            <div className="text-sm">Try a different filter or search</div>
          </div>
        ) : (
          paged.map((stock) =>
            viewMode === "detailed" ? (
              <TradeCard
                key={stock.symbol}
                stock={stock}
                portfolioValueUsd={portfolioValueUsd}
              />
            ) : (
              <StockCard key={stock.symbol} stock={stock} />
            )
          )
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 py-3">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="px-2.5 py-1 rounded text-[10px] font-semibold border-none cursor-pointer bg-white/[0.05] text-slate-400 disabled:opacity-30 disabled:cursor-default"
          >
            Prev
          </button>
          <span className="text-[10px] text-slate-500">
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="px-2.5 py-1 rounded text-[10px] font-semibold border-none cursor-pointer bg-white/[0.05] text-slate-400 disabled:opacity-30 disabled:cursor-default"
          >
            Next
          </button>
        </div>
      )}

      <div className="text-center py-4 text-[10px] text-slate-700">
        Data refreshes every 5 min · Not financial advice ·{" "}
        <a
          href="/logs"
          className="text-slate-500 hover:text-slate-400 underline"
        >
          system logs
        </a>
      </div>
    </div>
  );
}
