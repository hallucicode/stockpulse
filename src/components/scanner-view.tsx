"use client";

import { useState, useMemo, useEffect } from "react";
import { useStore } from "@/hooks/use-store";
import { TradeCard } from "./trade-card";
import { ScannerTable } from "./scanner-table";
import { RISK_CONFIG } from "@/lib/config";

// Phase 14 — persist the chosen layout across sessions so the user doesn't
// have to re-pick on every page load. SSR-safe: we read localStorage in a
// useEffect, not during render. Defensive against private-mode browsers
// where Storage methods throw.
type ViewMode = "detailed" | "compact";
const VIEW_MODE_STORAGE_KEY = "scanner-view-mode";

function useViewMode(): [ViewMode, (next: ViewMode) => void] {
  // Default to detailed — the labelled-row TradeCard is the recommended
  // layout. Compact is the dense table for scanning 50 names at once.
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

const PAGE_SIZE = 50;

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
        {/* Phase 14 — layout toggle. localStorage-persisted via useViewMode.
            Detailed = labelled-row TradeCard (depth per stock).
            Compact  = dense ScannerTable (50 names at a glance). */}
        <button
          onClick={() =>
            setViewMode(viewMode === "detailed" ? "compact" : "detailed")
          }
          aria-label="Toggle scanner view mode"
          title={
            viewMode === "detailed"
              ? "Switch to compact table"
              : "Switch to detailed trade cards"
          }
          className="px-2.5 py-1 rounded-full text-[10px] font-semibold border-none cursor-pointer transition-all bg-white/[0.03] text-slate-500 hover:text-slate-400"
        >
          {viewMode === "detailed" ? "Compact" : "Detailed"}
        </button>
      </div>

      {/* Result list — TradeCard stack OR ScannerTable, depending on mode */}
      {scannerLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : viewMode === "compact" ? (
        <ScannerTable stocks={paged} />
      ) : paged.length === 0 ? (
        <div className="text-center py-12 text-slate-500">
          <div className="text-2xl mb-2">No stocks found</div>
          <div className="text-sm">Try a different filter or search</div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {paged.map((stock) => (
            <TradeCard
              key={stock.symbol}
              stock={stock}
              portfolioValueUsd={portfolioValueUsd}
            />
          ))}
        </div>
      )}

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
