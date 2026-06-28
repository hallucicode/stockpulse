"use client";

// Phase 15a — historical-bars admin viewer.
//
// One table row per watchlist symbol with bar count, first/last
// available date, and a heuristic gap-count (>4 days between
// consecutive bars). Click a row to expand a sparkline of close
// prices so you can eyeball the data quality before downstream
// sub-phases (15b walk-forward simulator) depend on it.

import { Fragment, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Sparkline } from "@/components/sparkline";
import {
  BackfillProgressCard,
  type BackfillProgress,
} from "@/components/backfill-progress-card";
import { log } from "@/lib/logger";

interface SymbolSummary {
  symbol: string;
  barCount: number;
  firstDate: string | null;
  lastDate: string | null;
  gapCount: number;
}

interface BackfillSummary {
  totalSymbols: number;
  succeeded: number;
  empty: number;
  errored: number;
  totalBarsWritten: number;
}

// NDJSON event shapes streamed from the backfill API.
type BackfillEvent =
  | { kind: "start"; years: number }
  | {
      kind: "progress";
      symbol: string;
      processed: number;
      total: number;
      barsWrittenThisSymbol: number;
      status: "ok" | "empty" | "error";
    }
  | ({ kind: "done" } & BackfillSummary)
  | { kind: "error"; message: string };


interface BarRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toISOString().slice(0, 10);
}

export default function HistoricalPage() {
  const [summaries, setSummaries] = useState<SymbolSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [backfilling, setBackfilling] = useState(false);
  const [progress, setProgress] = useState<BackfillProgress | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [barsBySymbol, setBarsBySymbol] = useState<Record<string, BarRow[]>>(
    {}
  );

  const fetchSummaries = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/historical/symbols", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { summaries: SymbolSummary[] };
      setSummaries(body.summaries);
    } catch (err) {
      log.warn("historical-page", "summaries.fetch.failure", { error: err });
      setSummaries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSummaries();
  }, [fetchSummaries]);

  const handleBackfill = async () => {
    setBackfilling(true);
    setProgress({
      startedAt: Date.now(),
      currentSymbol: null,
      processed: 0,
      total: 0,
      succeeded: 0,
      empty: 0,
      errored: 0,
      totalBarsWritten: 0,
    });
    try {
      const res = await fetch("/api/historical/backfill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ years: 5 }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      // Read NDJSON stream line-by-line. Buffer holds the partial line
      // from the last chunk (network boundaries don't respect \n).
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let doneSummary: BackfillSummary | null = null;
      let streamError: string | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          if (!line.trim()) continue;
          let event: BackfillEvent;
          try {
            event = JSON.parse(line) as BackfillEvent;
          } catch {
            // Malformed line — skip rather than fail the whole stream.
            log.warn("historical-page", "stream.parse.failure", { line });
            continue;
          }
          if (event.kind === "progress") {
            setProgress((prev) =>
              prev
                ? {
                    ...prev,
                    currentSymbol: event.symbol,
                    processed: event.processed,
                    total: event.total,
                    succeeded:
                      event.status === "ok"
                        ? prev.succeeded + 1
                        : prev.succeeded,
                    empty:
                      event.status === "empty" ? prev.empty + 1 : prev.empty,
                    errored:
                      event.status === "error"
                        ? prev.errored + 1
                        : prev.errored,
                    totalBarsWritten:
                      prev.totalBarsWritten + event.barsWrittenThisSymbol,
                  }
                : prev
            );
          } else if (event.kind === "done") {
            doneSummary = event;
          } else if (event.kind === "error") {
            streamError = event.message;
          }
          // "start" event is informational; no UI change needed.
        }
      }

      if (streamError) throw new Error(streamError);
      if (doneSummary) {
        toast.success(
          `Backfill done: ${doneSummary.succeeded}/${doneSummary.totalSymbols} symbols, ` +
            `${doneSummary.totalBarsWritten.toLocaleString()} bars written ` +
            `(${doneSummary.empty} empty, ${doneSummary.errored} errored).`
        );
        await fetchSummaries();
      } else {
        // Stream ended without a "done" event — log + tolerate.
        log.warn("historical-page", "stream.no-done-event", {});
        toast.error("Backfill finished but no summary received — check /logs.");
      }
    } catch (err) {
      log.warn("historical-page", "backfill.failure", { error: err });
      toast.error("Backfill failed — check /logs.");
    } finally {
      setBackfilling(false);
      setProgress(null);
    }
  };

  const toggleExpand = async (symbol: string) => {
    if (expanded === symbol) {
      setExpanded(null);
      return;
    }
    setExpanded(symbol);
    if (!barsBySymbol[symbol]) {
      try {
        const res = await fetch(`/api/historical/bars/${symbol}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { bars: BarRow[] };
        setBarsBySymbol((prev) => ({ ...prev, [symbol]: body.bars }));
      } catch (err) {
        log.warn("historical-page", "bars.fetch.failure", {
          symbol,
          error: err,
        });
      }
    }
  };

  return (
    <div className="p-4 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-extrabold">Historical bars</h1>
          <div className="text-[11px] text-slate-500 mt-0.5">
            Daily OHLCV per watchlist symbol. Used by the backtest engine
            (Phase 15b+). Backfill runs are manual.
          </div>
        </div>
        <button
          onClick={handleBackfill}
          disabled={backfilling}
          className="px-3 py-1.5 rounded-md text-[11px] font-semibold bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 cursor-pointer hover:bg-cyan-500/20 transition-colors disabled:opacity-50"
        >
          {backfilling ? "Backfilling…" : "Backfill watchlist (5y)"}
        </button>
      </div>

      {progress && <BackfillProgressCard progress={progress} />}

      {loading ? (
        <div className="text-slate-500 text-sm">Loading…</div>
      ) : !summaries || summaries.length === 0 ? (
        <div className="text-slate-500 text-sm">
          No watchlist symbols. Add some on /portfolio first, then come back
          and click Backfill.
        </div>
      ) : (
        <div className="rounded-lg border border-white/[0.06] overflow-hidden">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-white/[0.03] text-slate-500 uppercase tracking-wider text-[9px]">
                <th className="text-left px-3 py-2 font-semibold">Symbol</th>
                <th className="text-right px-3 py-2 font-semibold">Bars</th>
                <th className="text-left px-3 py-2 font-semibold">
                  First date
                </th>
                <th className="text-left px-3 py-2 font-semibold">Last date</th>
                <th className="text-right px-3 py-2 font-semibold">Gaps</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((s) => {
                const isOpen = expanded === s.symbol;
                const bars = barsBySymbol[s.symbol];
                const closes = bars?.map((b) => b.close) ?? [];
                return (
                  <Fragment key={s.symbol}>
                    <tr
                      onClick={() => toggleExpand(s.symbol)}
                      className="border-t border-white/[0.04] hover:bg-white/[0.03] cursor-pointer"
                    >
                      <td className="px-3 py-2 font-extrabold">{s.symbol}</td>
                      <td
                        className={`px-3 py-2 text-right font-mono ${s.barCount === 0 ? "text-amber-300" : "text-slate-300"}`}
                      >
                        {s.barCount.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-slate-400 font-mono">
                        {formatDate(s.firstDate)}
                      </td>
                      <td className="px-3 py-2 text-slate-400 font-mono">
                        {formatDate(s.lastDate)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-mono ${s.gapCount > 0 ? "text-amber-300" : "text-slate-500"}`}
                      >
                        {s.gapCount}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-t border-white/[0.04] bg-white/[0.01]">
                        <td colSpan={5} className="px-3 py-3">
                          {bars === undefined ? (
                            <div className="text-slate-500">Loading bars…</div>
                          ) : closes.length < 2 ? (
                            <div className="text-amber-300">
                              No bars cached — backfill first.
                            </div>
                          ) : (
                            <div className="flex items-center gap-4">
                              <Sparkline
                                data={closes}
                                width={600}
                                height={80}
                              />
                              <div className="text-[10px] text-slate-500 font-mono">
                                <div>
                                  Low: $
                                  {Math.min(...closes).toFixed(2)}
                                </div>
                                <div>
                                  High: $
                                  {Math.max(...closes).toFixed(2)}
                                </div>
                                <div>Latest: ${closes[closes.length - 1].toFixed(2)}</div>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
