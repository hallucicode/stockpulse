"use client";

// Phase 15a.1 — live progress card for the watchlist backfill stream.
//
// Used by /historical to render an in-flight backfill: progress bar,
// current symbol, ETA extrapolated from elapsed / processed, and
// running tallies of succeeded / empty / errored.
//
// Pure presentation: shape is a single BackfillProgress object owned
// by the caller. ETA math is local (cheap to compute on every render).

export interface BackfillProgress {
  /** ms epoch when the run started. Drives ETA extrapolation. */
  startedAt: number;
  /** Latest symbol being processed. null before any progress event. */
  currentSymbol: string | null;
  processed: number;
  total: number;
  succeeded: number;
  empty: number;
  errored: number;
  totalBarsWritten: number;
}

export function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  return `${min} min`;
}

export function BackfillProgressCard({
  progress,
  /** Injectable for tests so we can assert ETA deterministically. */
  now = Date.now(),
}: {
  progress: BackfillProgress;
  now?: number;
}) {
  const pct = progress.total > 0 ? progress.processed / progress.total : 0;
  const elapsed = now - progress.startedAt;
  // ETA: linear extrapolation from elapsed / processed × remaining.
  // Guarded against divide-by-zero for the very first event.
  const eta =
    progress.processed > 0
      ? (elapsed / progress.processed) * (progress.total - progress.processed)
      : NaN;

  return (
    <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/[0.04] p-3 mb-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] font-semibold text-cyan-300">
          📥 Backfilling watchlist
        </div>
        <div className="text-[10px] text-slate-400 font-mono">
          {progress.processed} / {progress.total} · ETA {formatEta(eta)}
        </div>
      </div>
      <div
        className="h-1.5 rounded-full bg-white/5 overflow-hidden"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.processed}
      >
        <div
          className="h-full bg-cyan-400 transition-all"
          style={{ width: `${(pct * 100).toFixed(1)}%` }}
        />
      </div>
      <div className="flex items-center justify-between mt-2 text-[10px]">
        <div className="text-slate-400 font-mono">
          Now:{" "}
          <span className="text-slate-200">
            {progress.currentSymbol ?? "starting…"}
          </span>
        </div>
        <div className="flex gap-3 font-mono">
          <span className="text-emerald-300">✓ {progress.succeeded}</span>
          <span className="text-slate-500">— {progress.empty}</span>
          <span className="text-rose-300">✗ {progress.errored}</span>
          <span className="text-slate-500">
            {progress.totalBarsWritten.toLocaleString()} bars
          </span>
        </div>
      </div>
    </div>
  );
}
