"use client";

import { useEffect, useState, useCallback } from "react";
import { formatAge, formatInterval, type ComponentHealth } from "@/lib/health";

interface Entry {
  id: string;
  timestamp: string;
  level: string;
  component: string;
  event: string;
  meta: Record<string, unknown> | null;
}

interface ApiResponse {
  entries: Entry[];
  health: ComponentHealth[];
  /** Every distinct component name that has ever logged — fed into the filter dropdown. */
  components: string[];
  total: number;
}

const POLL_MS = 15_000;

const STATUS_STYLE: Record<ComponentHealth["status"], string> = {
  ok: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  stale: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  failing: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  starting: "bg-cyan-500/10 text-cyan-300 border-cyan-500/30",
  unknown: "bg-slate-500/10 text-slate-400 border-slate-500/30",
};

const STATUS_ICON: Record<ComponentHealth["status"], string> = {
  ok: "✓",
  stale: "⚠",
  failing: "✗",
  starting: "↻",
  unknown: "?",
};

const STATUS_NOTE: Record<ComponentHealth["status"], string> = {
  ok: "",
  stale: "Last successful run is older than expected — check recent issues.",
  failing: "Recent errors detected — see entries below.",
  starting: "Refresh cycle in progress. Per-stock warnings during a refresh are normal; wait for it to complete.",
  unknown: "No activity seen in the last 24h.",
};

const LEVEL_STYLE: Record<string, string> = {
  error: "text-rose-400",
  warn: "text-amber-300",
  info: "text-slate-400",
  debug: "text-slate-600",
};

export default function LogsPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterLevel, setFilterLevel] = useState<string>("all");
  const [filterComponent, setFilterComponent] = useState<string>("all");

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filterLevel !== "all") params.set("level", filterLevel);
      if (filterComponent !== "all") params.set("component", filterComponent);
      params.set("limit", "200");
      const res = await fetch(`/api/logs?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ApiResponse;
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [filterLevel, filterComponent]);

  useEffect(() => {
    fetchLogs();
    const id = setInterval(fetchLogs, POLL_MS);
    return () => clearInterval(id);
  }, [fetchLogs]);

  // Use the server-provided full distinct list of components so the
  // dropdown is complete (the user's current page of `entries` only
  // contains a recent subset).
  const components = data?.components ?? [];

  return (
    <div className="min-h-screen bg-[var(--bg-app)] text-slate-200 p-4 md:p-8 max-w-6xl mx-auto">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold">System logs</h1>
          <div className="text-xs text-slate-500 mt-1">
            Auto-refreshes every 15s · {data?.total ?? 0} entries shown
          </div>
        </div>
        <a
          href="/"
          className="text-xs px-3 py-1.5 rounded bg-white/[0.05] text-slate-300 hover:bg-white/[0.10]"
        >
          ← Back to scanner
        </a>
      </header>

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 mb-4 text-rose-300 text-sm">
          Failed to load logs: {error}
        </div>
      )}

      {/* ── Health summary ── */}
      <section className="mb-6">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-2">
          Component health{" "}
          <span className="text-slate-600 normal-case font-normal">
            · errors/warnings counted in last 24h
          </span>
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {(data?.health ?? []).map((h) => (
            <HealthCard key={h.component} health={h} />
          ))}
        </div>
      </section>

      {/* ── Filters ── */}
      <section className="mb-3 flex flex-wrap gap-x-4 gap-y-2 items-center">
        {/* Level — only 4 options, chips read well */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">Level:</span>
          {["all", "error", "warn", "info"].map((l) => (
            <button
              key={l}
              onClick={() => setFilterLevel(l)}
              className={`px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer ${
                filterLevel === l
                  ? "bg-cyan-500/15 text-cyan-300"
                  : "bg-white/[0.03] text-slate-500"
              }`}
            >
              {l}
            </button>
          ))}
        </div>

        {/* Component — up to ~20 options, use a dropdown so we don't
            sprawl across multiple rows. */}
        <div className="flex items-center gap-2">
          <label
            htmlFor="component-filter"
            className="text-xs text-slate-500"
          >
            Component:
          </label>
          <select
            id="component-filter"
            value={filterComponent}
            onChange={(e) => setFilterComponent(e.target.value)}
            className={`px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer border-none outline-none appearance-none pr-7 ${
              filterComponent === "all"
                ? "bg-white/[0.05] text-slate-300"
                : "bg-cyan-500/15 text-cyan-300"
            }`}
            style={{
              backgroundImage:
                "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M3 5l3 3 3-3' fill='none' stroke='%2394a3b8' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>\")",
              backgroundRepeat: "no-repeat",
              backgroundPosition: "right 6px center",
              backgroundSize: "10px",
            }}
          >
            <option value="all">all ({components.length})</option>
            {components.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* ── Entries table ── */}
      <section>
        {data?.entries.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <div className="text-base">No log entries yet</div>
            <div className="text-xs mt-1">
              Logs are persisted as the app runs. Wait for the next refresh
              cycle, or restart the dev server.
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-white/5 overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-white/[0.02] text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold">Time</th>
                  <th className="text-left px-3 py-2 font-semibold">Level</th>
                  <th className="text-left px-3 py-2 font-semibold">
                    Component
                  </th>
                  <th className="text-left px-3 py-2 font-semibold">Event</th>
                  <th className="text-left px-3 py-2 font-semibold">Detail</th>
                </tr>
              </thead>
              <tbody>
                {(data?.entries ?? []).map((e) => (
                  <tr
                    key={e.id}
                    className="border-t border-white/[0.03] hover:bg-white/[0.02]"
                  >
                    <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">
                      {new Date(e.timestamp).toLocaleTimeString()}
                    </td>
                    <td
                      className={`px-3 py-1.5 font-bold uppercase ${LEVEL_STYLE[e.level] ?? ""}`}
                    >
                      {e.level}
                    </td>
                    <td className="px-3 py-1.5 text-slate-400">
                      {e.component}
                    </td>
                    <td className="px-3 py-1.5 text-slate-300 font-mono">
                      {e.event}
                    </td>
                    <td className="px-3 py-1.5 text-slate-500 font-mono text-[11px] max-w-md truncate">
                      {e.meta ? formatMeta(e.meta) : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function HealthCard({ health }: { health: ComponentHealth }) {
  return (
    <div
      className={`rounded-lg border p-3 ${STATUS_STYLE[health.status]}`}
      title={health.description}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wider">
          {health.label}
        </span>
        <span className="text-base font-bold">
          {STATUS_ICON[health.status]}
        </span>
      </div>
      <div className="text-[11px] mt-1 opacity-80">{health.description}</div>
      <div className="text-[10px] mt-1 opacity-60">
        Runs every {formatInterval(health.refreshIntervalMs)}
      </div>
      {STATUS_NOTE[health.status] && (
        <div className="text-[11px] mt-1 opacity-80 italic">
          {STATUS_NOTE[health.status]}
        </div>
      )}
      <div className="mt-2 flex gap-3 text-[11px]">
        <span>Last ok: {formatAge(health.lastSuccessAgeSec)}</span>
        {health.recentErrors > 0 && (
          <span className="text-rose-300">
            {health.recentErrors} error{health.recentErrors === 1 ? "" : "s"}
          </span>
        )}
        {health.recentWarnings > 0 && (
          <span>
            {health.recentWarnings} warn
            {health.recentWarnings === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </div>
  );
}

function formatMeta(meta: Record<string, unknown>): string {
  const pairs = Object.entries(meta).map(([k, v]) => {
    if (v === null || v === undefined) return `${k}=null`;
    if (typeof v === "object") {
      const nested = v as Record<string, unknown>;
      if ("message" in nested) return `${k}="${String(nested.message)}"`;
      try {
        return `${k}=${JSON.stringify(v)}`;
      } catch {
        return `${k}=[object]`;
      }
    }
    return `${k}=${String(v)}`;
  });
  return pairs.join(" · ");
}
