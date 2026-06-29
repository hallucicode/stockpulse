"use client";

// Phase 15b — minimal /backtest UI.
//
// Form inputs: startDate, endDate, startingCapital. "Run backtest"
// posts to /api/backtest/run, consumes the NDJSON stream, renders a
// live progress card while running, then a summary card + paginated
// trade list when done.
//
// Charts (equity curve, drawdown) and per-regime / per-signal
// attribution land in 15c and 15d. This page is intentionally minimal.

import { useState } from "react";
import { toast } from "sonner";
import { log } from "@/lib/logger";

interface BacktestSummary {
  symbolsConsidered: number;
  symbolsWithEnoughHistory: number;
  tradesCount: number;
  winningTrades: number;
  losingTrades: number;
  startingCapital: number;
  endingCapital: number;
  totalReturn: number;
  totalReturnPct: number;
  cashRemaining: number;
}

interface BacktestTrade {
  symbol: string;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  shares: number;
  exitReason: "stop" | "target" | "end_of_window";
  pl: number;
  plPct: number;
  signalsAtEntry: string[];
  scoreAtEntry: number;
}

interface BacktestResult {
  trades: BacktestTrade[];
  equityCurve: Array<{ date: string; equity: number }>;
  summary: BacktestSummary;
}

type RunEvent =
  | { kind: "start"; startDate: string; endDate: string; startingCapital: number }
  | {
      kind: "progress";
      day: number;
      totalDays: number;
      date: string;
      equity: number;
      openPositions: number;
      tradesClosed: number;
    }
  | { kind: "done"; runId: string; result: BacktestResult }
  | { kind: "error"; message: string };

interface ProgressState {
  startedAt: number;
  day: number;
  totalDays: number;
  currentDate: string;
  equity: number;
  openPositions: number;
  tradesClosed: number;
}

function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  return `${min} min`;
}

function defaultStart(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function defaultEnd(): string {
  return new Date().toISOString().slice(0, 10);
}

const TRADE_PAGE_SIZE = 25;

export default function BacktestPage() {
  const [startDate, setStartDate] = useState(defaultStart());
  const [endDate, setEndDate] = useState(defaultEnd());
  const [startingCapital, setStartingCapital] = useState(50_000);
  // Filter knobs — defaults applied if checkbox is on. Off = no filter
  // at that dimension (the original Phase 15b indiscriminate baseline).
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [filterScoreOn, setFilterScoreOn] = useState(true);
  const [minScore, setMinScore] = useState(40);
  const [filterAdvOn, setFilterAdvOn] = useState(true);
  const [minAvgDollarVolume, setMinAvgDollarVolume] = useState(20_000_000);
  const [filterRrOn, setFilterRrOn] = useState(true);
  const [minRiskReward, setMinRiskReward] = useState(2.5);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [tradesPage, setTradesPage] = useState(0);

  const handleRun = async () => {
    setRunning(true);
    setResult(null);
    setTradesPage(0);
    setProgress({
      startedAt: Date.now(),
      day: 0,
      totalDays: 0,
      currentDate: "",
      equity: startingCapital,
      openPositions: 0,
      tradesClosed: 0,
    });
    try {
      const filters: Record<string, number> = {};
      if (filterScoreOn) filters.minScore = minScore;
      if (filterAdvOn) filters.minAvgDollarVolume = minAvgDollarVolume;
      if (filterRrOn) filters.minRiskReward = minRiskReward;
      const res = await fetch("/api/backtest/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          startDate,
          endDate,
          startingCapital,
          filters: Object.keys(filters).length > 0 ? filters : undefined,
        }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamError: string | null = null;
      let finalResult: BacktestResult | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let event: RunEvent;
          try {
            event = JSON.parse(line) as RunEvent;
          } catch {
            log.warn("backtest-page", "stream.parse.failure", { line });
            continue;
          }
          if (event.kind === "progress") {
            setProgress((prev) =>
              prev
                ? {
                    ...prev,
                    day: event.day,
                    totalDays: event.totalDays,
                    currentDate: event.date,
                    equity: event.equity,
                    openPositions: event.openPositions,
                    tradesClosed: event.tradesClosed,
                  }
                : prev
            );
          } else if (event.kind === "done") {
            finalResult = event.result;
          } else if (event.kind === "error") {
            streamError = event.message;
          }
        }
      }

      if (streamError) throw new Error(streamError);
      if (finalResult) {
        setResult(finalResult);
        toast.success(
          `Backtest done: ${finalResult.summary.tradesCount} trades, ` +
            `return ${finalResult.summary.totalReturnPct.toFixed(2)}%`
        );
      } else {
        toast.error("Backtest finished but no result received — check /logs.");
      }
    } catch (err) {
      log.warn("backtest-page", "run.failure", { error: err });
      const msg = err instanceof Error ? err.message : "Backtest failed";
      toast.error(msg);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const pagedTrades = result?.trades.slice(
    tradesPage * TRADE_PAGE_SIZE,
    (tradesPage + 1) * TRADE_PAGE_SIZE
  );
  const totalPages = result
    ? Math.max(1, Math.ceil(result.trades.length / TRADE_PAGE_SIZE))
    : 0;

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <div className="mb-4">
        <h1 className="text-xl font-extrabold">Backtest</h1>
        <div className="text-[11px] text-slate-500 mt-0.5">
          Walk-forward simulation over the cached HistoricalBar series.
          Technical-only signals (no catalysts / regime / options yet —
          Phase 15.x).
        </div>
      </div>

      {/* Survivorship-bias banner — prominent. Phase 15d will style
          this with the rest of the polish, but it's load-bearing
          enough that we ship it now. */}
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 mb-4 text-[11px] text-amber-200">
        <span className="font-bold">⚠ Survivorship bias:</span> Yahoo only
        serves currently-listed tickers, so this backtest can&apos;t see
        delisted names. Returns are biased upward. Real fix lives in the
        Phase 15 follow-up backlog (paid Norgate-style data).
      </div>

      {/* Form */}
      <div className="rounded-lg border border-white/[0.06] p-3 mb-3">
        <div className="grid grid-cols-3 gap-3 mb-3">
          <label className="flex flex-col gap-1 text-[10px] text-slate-500 uppercase tracking-wider">
            Start date
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              disabled={running}
              className="px-2 py-1.5 rounded-md bg-white/[0.03] border border-white/[0.06] text-[12px] text-slate-200 outline-none focus:border-cyan-500/30 disabled:opacity-50"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] text-slate-500 uppercase tracking-wider">
            End date
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              disabled={running}
              className="px-2 py-1.5 rounded-md bg-white/[0.03] border border-white/[0.06] text-[12px] text-slate-200 outline-none focus:border-cyan-500/30 disabled:opacity-50"
            />
          </label>
          <label className="flex flex-col gap-1 text-[10px] text-slate-500 uppercase tracking-wider">
            Starting capital ($)
            <input
              type="number"
              min={1000}
              step={1000}
              value={startingCapital}
              onChange={(e) => setStartingCapital(Number(e.target.value))}
              disabled={running}
              className="px-2 py-1.5 rounded-md bg-white/[0.03] border border-white/[0.06] text-[12px] text-slate-200 font-mono outline-none focus:border-cyan-500/30 disabled:opacity-50"
            />
          </label>
        </div>

        {/* Filter section — collapsible. Defaults to open + all three
            filters enabled because the unfiltered baseline measured
            the indiscriminate "trade every BUY signal" strategy which
            is dominated by noise. Disable filters individually to see
            how the unfiltered behaviour compares. */}
        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold hover:text-slate-400 mb-2"
        >
          {filtersOpen ? "▼" : "▶"} Signal filters
        </button>
        {filtersOpen && (
          <div className="rounded-md bg-white/[0.02] p-3 mb-3 flex flex-col gap-2.5">
            <label className="flex items-center gap-2 text-[11px]">
              <input
                type="checkbox"
                checked={filterScoreOn}
                onChange={(e) => setFilterScoreOn(e.target.checked)}
                disabled={running}
              />
              <span className="text-slate-400 w-44 shrink-0">
                Min composite score
              </span>
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                value={minScore}
                onChange={(e) => setMinScore(Number(e.target.value))}
                disabled={running || !filterScoreOn}
                className="w-20 px-2 py-1 rounded bg-white/[0.03] border border-white/[0.06] text-slate-200 font-mono outline-none focus:border-cyan-500/30 disabled:opacity-50"
              />
              <span className="text-[10px] text-slate-600">
                40 = STRONG BUY only · 15 = BUY threshold · 0 = all
              </span>
            </label>
            <label className="flex items-center gap-2 text-[11px]">
              <input
                type="checkbox"
                checked={filterAdvOn}
                onChange={(e) => setFilterAdvOn(e.target.checked)}
                disabled={running}
              />
              <span className="text-slate-400 w-44 shrink-0">
                Min avg dollar volume
              </span>
              <input
                type="number"
                min={0}
                step={1_000_000}
                value={minAvgDollarVolume}
                onChange={(e) =>
                  setMinAvgDollarVolume(Number(e.target.value))
                }
                disabled={running || !filterAdvOn}
                className="w-32 px-2 py-1 rounded bg-white/[0.03] border border-white/[0.06] text-slate-200 font-mono outline-none focus:border-cyan-500/30 disabled:opacity-50"
              />
              <span className="text-[10px] text-slate-600">
                $20M = drops illiquid junk · $50M = liquid large caps
              </span>
            </label>
            <label className="flex items-center gap-2 text-[11px]">
              <input
                type="checkbox"
                checked={filterRrOn}
                onChange={(e) => setFilterRrOn(e.target.checked)}
                disabled={running}
              />
              <span className="text-slate-400 w-44 shrink-0">Min R:R</span>
              <input
                type="number"
                min={0}
                step={0.5}
                value={minRiskReward}
                onChange={(e) => setMinRiskReward(Number(e.target.value))}
                disabled={running || !filterRrOn}
                className="w-20 px-2 py-1 rounded bg-white/[0.03] border border-white/[0.06] text-slate-200 font-mono outline-none focus:border-cyan-500/30 disabled:opacity-50"
              />
              <span className="text-[10px] text-slate-600">
                Skip setups where reward-to-risk &lt; this
              </span>
            </label>
          </div>
        )}

        <div className="flex justify-end">
          <button
            onClick={handleRun}
            disabled={running}
            className="px-4 py-1.5 rounded-md text-[11px] font-semibold bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 cursor-pointer hover:bg-cyan-500/20 transition-colors disabled:opacity-50"
          >
            {running ? "Running…" : "Run backtest"}
          </button>
        </div>
      </div>

      {/* Progress card */}
      {progress && (
        <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/[0.04] p-3 mb-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] font-semibold text-cyan-300">
              📊 Simulating
            </div>
            <div className="text-[10px] text-slate-400 font-mono">
              {progress.day} / {progress.totalDays || "?"} · ETA{" "}
              {formatEta(
                progress.day > 0
                  ? ((Date.now() - progress.startedAt) / progress.day) *
                      (progress.totalDays - progress.day)
                  : NaN
              )}
            </div>
          </div>
          <div
            className="h-1.5 rounded-full bg-white/5 overflow-hidden"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.totalDays}
            aria-valuenow={progress.day}
          >
            <div
              className="h-full bg-cyan-400 transition-all"
              style={{
                width: `${progress.totalDays > 0 ? ((progress.day / progress.totalDays) * 100).toFixed(1) : 0}%`,
              }}
            />
          </div>
          <div className="flex items-center justify-between mt-2 text-[10px] font-mono">
            <div className="text-slate-400">
              Day:{" "}
              <span className="text-slate-200">
                {progress.currentDate || "starting…"}
              </span>
            </div>
            <div className="flex gap-3">
              <span className="text-slate-300">
                Equity ${progress.equity.toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </span>
              <span className="text-cyan-300">
                Open {progress.openPositions}
              </span>
              <span className="text-amber-300">
                Closed {progress.tradesClosed}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Summary card */}
      {result && (
        <div className="rounded-lg border border-white/[0.06] p-3 mb-3">
          <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2 font-semibold">
            Summary
          </div>
          <div className="grid grid-cols-4 gap-3 text-center">
            <div className="bg-white/[0.02] rounded p-2">
              <div className="text-[9px] text-slate-500 uppercase tracking-wider">
                Total return
              </div>
              <div
                className={`text-[16px] font-extrabold ${result.summary.totalReturnPct >= 0 ? "text-emerald-300" : "text-rose-300"}`}
              >
                {result.summary.totalReturnPct >= 0 ? "+" : ""}
                {result.summary.totalReturnPct.toFixed(2)}%
              </div>
            </div>
            <div className="bg-white/[0.02] rounded p-2">
              <div className="text-[9px] text-slate-500 uppercase tracking-wider">
                P&L
              </div>
              <div
                className={`text-[16px] font-extrabold ${result.summary.totalReturn >= 0 ? "text-emerald-300" : "text-rose-300"}`}
              >
                {result.summary.totalReturn >= 0 ? "+" : "-"}$
                {Math.abs(result.summary.totalReturn).toLocaleString("en-US", {
                  maximumFractionDigits: 0,
                })}
              </div>
            </div>
            <div className="bg-white/[0.02] rounded p-2">
              <div className="text-[9px] text-slate-500 uppercase tracking-wider">
                Trades
              </div>
              <div className="text-[16px] font-extrabold">
                {result.summary.tradesCount}
                <span className="text-[10px] text-slate-500 ml-1 font-normal">
                  ({result.summary.winningTrades}W / {result.summary.losingTrades}L)
                </span>
              </div>
            </div>
            <div className="bg-white/[0.02] rounded p-2">
              <div className="text-[9px] text-slate-500 uppercase tracking-wider">
                Symbols
              </div>
              <div className="text-[16px] font-extrabold">
                {result.summary.symbolsWithEnoughHistory}
                <span className="text-[10px] text-slate-500 ml-1 font-normal">
                  / {result.summary.symbolsConsidered}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Trade list */}
      {result && result.trades.length > 0 && pagedTrades && (
        <div className="rounded-lg border border-white/[0.06] overflow-hidden">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-white/[0.03] text-slate-500 uppercase tracking-wider text-[9px]">
                <th className="text-left px-2 py-1.5 font-semibold">Sym</th>
                <th className="text-left px-2 py-1.5 font-semibold">Entry</th>
                <th className="text-left px-2 py-1.5 font-semibold">Exit</th>
                <th className="text-right px-2 py-1.5 font-semibold">Shares</th>
                <th className="text-right px-2 py-1.5 font-semibold">P&L</th>
                <th className="text-right px-2 py-1.5 font-semibold">P&L %</th>
                <th className="text-left px-2 py-1.5 font-semibold">Reason</th>
                <th className="text-right px-2 py-1.5 font-semibold">Score</th>
              </tr>
            </thead>
            <tbody>
              {pagedTrades.map((t, i) => (
                <tr
                  key={`${t.symbol}-${t.entryDate}-${i}`}
                  className="border-t border-white/[0.04] hover:bg-white/[0.03]"
                >
                  <td className="px-2 py-1.5 font-extrabold">{t.symbol}</td>
                  <td className="px-2 py-1.5 text-slate-400 font-mono">
                    {t.entryDate.slice(0, 10)} @ ${t.entryPrice.toFixed(2)}
                  </td>
                  <td className="px-2 py-1.5 text-slate-400 font-mono">
                    {t.exitDate.slice(0, 10)} @ ${t.exitPrice.toFixed(2)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">
                    {t.shares}
                  </td>
                  <td
                    className={`px-2 py-1.5 text-right font-mono font-bold ${t.pl >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                  >
                    {t.pl >= 0 ? "+" : "-"}$
                    {Math.abs(t.pl).toFixed(2)}
                  </td>
                  <td
                    className={`px-2 py-1.5 text-right font-mono ${t.plPct >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                  >
                    {t.plPct >= 0 ? "+" : ""}
                    {t.plPct.toFixed(2)}%
                  </td>
                  <td className="px-2 py-1.5 text-slate-400 text-[10px]">
                    {t.exitReason}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-cyan-400">
                    {t.scoreAtEntry > 0 ? "+" : ""}
                    {t.scoreAtEntry.toFixed(0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 py-2 border-t border-white/[0.04]">
              <button
                onClick={() => setTradesPage((p) => Math.max(0, p - 1))}
                disabled={tradesPage === 0}
                className="px-2.5 py-1 rounded text-[10px] font-semibold border-none cursor-pointer bg-white/[0.05] text-slate-400 disabled:opacity-30 disabled:cursor-default"
              >
                Prev
              </button>
              <span className="text-[10px] text-slate-500">
                Page {tradesPage + 1} of {totalPages}
              </span>
              <button
                onClick={() => setTradesPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={tradesPage >= totalPages - 1}
                className="px-2.5 py-1 rounded text-[10px] font-semibold border-none cursor-pointer bg-white/[0.05] text-slate-400 disabled:opacity-30 disabled:cursor-default"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {/* No-trades note when summary is present but list is empty */}
      {result && result.trades.length === 0 && (
        <div className="rounded-lg border border-white/[0.06] p-3 text-[11px] text-slate-500 text-center">
          No trades generated in this window. Either the strategy didn&apos;t
          fire on any cached symbol, or the date range is too short. Try a
          wider range or check /historical for data availability.
        </div>
      )}
    </div>
  );
}
