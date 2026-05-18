// Phase 11 — recommendation audit log (edge module).
//
// Permanent timeline of every distinct recommendation. `AnalysisCache`
// only holds the *current* analysis — overwriting destroys the BUY →
// HOLD → BUY transitions that Phase 15 (backtest) and Phase 18 (decay
// monitor) need to evaluate signal quality over time.
//
// Three jobs:
//   1. `maybeLogRecommendation(symbol, analysis)` — write-on-change. The
//      fetcher calls this once per stock per cycle. Internally it hashes
//      a canonical key (score / recommendation / regime / catalysts /
//      veto) and only inserts a new row when the hash differs from the
//      most recent row for that symbol. Identical re-runs cost a single
//      indexed lookup.
//   2. `getAuditTrail(symbol, opts)` — read API consumed by
//      `/api/audit/[symbol]/route.ts`. Chronologically ascending,
//      bounded by `maxReadRows` for defensiveness.
//   3. `pruneOldRecommendations()` — daily cron deletes rows older than
//      `retentionDays`. Forward TODO for Phase 16: exclude symbols with
//      open paper trades from pruning.

import { createHash } from "node:crypto";
import { db } from "./db";
import { log } from "./logger";
import { RECOMMENDATION_LOG_CONFIG } from "./config";
import type { Analysis } from "@/types";

/**
 * JSON-shape version stamped on every row. Bump this when a breaking
 * change to the persisted `signalBreakdown` shape lands — e.g. a field
 * rename or a unit change that older Phase 15 readers can't infer.
 *
 * Pinned at write time (rather than backfilled retroactively) because
 * once we have millions of rows the migration cost dominates the cost
 * of adding the column. Bumping this in code requires:
 *   1. Increment the constant.
 *   2. Phase 15 reader switches on `row.schemaVersion` to handle old
 *      and new shapes.
 *   3. Existing rows keep their old version — they're still readable
 *      via the v1 branch.
 *
 * Additive changes to `Analysis` (new optional fields) do NOT require
 * a bump; missing fields naturally default to undefined on read.
 */
export const SCHEMA_VERSION = 1 as const;

/**
 * Canonical change-detection key. Hash the *externally-observable*
 * state — not every signal weight bouncing around with noise, just the
 * fields a human (or backtest) would describe as "the system's view of
 * this stock changed".
 *
 * Pure: same input → same hash.
 */
export function hashRecommendationKey(analysis: Analysis): string {
  const present = (analysis.catalysts?.present ?? []).slice().sort();
  const key = {
    score: analysis.compositeScore,
    recommendation: analysis.recommendation,
    regime: analysis.regime?.regime ?? null,
    catalysts: present,
    veto: analysis.qualityVeto?.reason ?? null,
  };
  return createHash("sha1").update(JSON.stringify(key)).digest("hex");
}

/**
 * Strip the UI-derived `signals[]` array from the analysis before
 * persistence. Everything else is preserved for replay. `signals[]` is
 * cheap to reconstruct from the rest (each phase's "applyXAdjustment"
 * synthesises its own signal); persisting it would inflate row size
 * 2-3× with no replay value.
 */
function snapshotForPersistence(analysis: Analysis): string {
  // Spread first so we don't mutate the caller's object.
  const { signals: _signals, ...rest } = analysis;
  void _signals;
  return JSON.stringify(rest);
}

/**
 * Look up the most recent row for `symbol` and write a new one iff the
 * canonical hash differs. Best-effort: any failure (DB hiccup, encode
 * failure) is logged via `audit-log:write.failure` but never thrown to
 * the caller — the fetcher must never break because of audit-log
 * persistence.
 */
export async function maybeLogRecommendation(
  symbol: string,
  analysis: Analysis
): Promise<{ wrote: boolean; reason: "first-row" | "changed" | "unchanged" | "error" }> {
  try {
    const hash = hashRecommendationKey(analysis);
    const previous = await db.recommendationLog.findFirst({
      where: { symbol },
      orderBy: { timestamp: "desc" },
      select: { analysisHash: true },
    });
    if (previous?.analysisHash === hash) {
      return { wrote: false, reason: "unchanged" };
    }
    await db.recommendationLog.create({
      data: {
        symbol,
        compositeScore: Math.round(analysis.compositeScore),
        recommendation: analysis.recommendation,
        regime: analysis.regime?.regime ?? null,
        schemaVersion: SCHEMA_VERSION,
        analysisHash: hash,
        signalBreakdown: snapshotForPersistence(analysis),
      },
    });
    return {
      wrote: true,
      reason: previous ? "changed" : "first-row",
    };
  } catch (err) {
    log.warn("audit-log", "write.failure", { symbol, error: err });
    return { wrote: false, reason: "error" };
  }
}

export interface AuditTrailOptions {
  /** Inclusive ISO date or Date. Defaults to (now - defaultReadWindowDays). */
  from?: Date | string;
  /** Inclusive upper bound. Defaults to now. */
  to?: Date | string;
  /** Hard cap, defaults to RECOMMENDATION_LOG_CONFIG.maxReadRows. */
  limit?: number;
}

export interface AuditRow {
  timestamp: string;
  compositeScore: number;
  recommendation: string;
  regime: string | null;
  /**
   * The `SCHEMA_VERSION` the writer was on when this row was persisted.
   * Phase 15 backtest replays branch on this to handle old shapes
   * after breaking-change bumps.
   */
  schemaVersion: number;
  analysisHash: string;
  /** Parsed back into the structured shape — easier for downstream consumers. */
  analysis: unknown;
}

/**
 * Read the audit trail for a single symbol, chronologically ascending.
 * Returns an empty array when no rows exist in the window.
 *
 * `limit` is capped at `maxReadRows` regardless of the caller's input
 * — defensive against a runaway caller pulling years of data in one
 * HTTP response.
 */
export async function getAuditTrail(
  symbol: string,
  opts: AuditTrailOptions = {}
): Promise<AuditRow[]> {
  const cfg = RECOMMENDATION_LOG_CONFIG;
  const now = new Date();
  const defaultFrom = new Date(
    now.getTime() - cfg.defaultReadWindowDays * 86_400_000
  );
  const from = parseDate(opts.from) ?? defaultFrom;
  const to = parseDate(opts.to) ?? now;
  const limit = Math.min(opts.limit ?? cfg.maxReadRows, cfg.maxReadRows);

  const rows = await db.recommendationLog.findMany({
    where: {
      symbol,
      timestamp: { gte: from, lte: to },
    },
    orderBy: { timestamp: "asc" },
    take: limit,
  });

  return rows.map((r) => ({
    timestamp: r.timestamp.toISOString(),
    compositeScore: r.compositeScore,
    recommendation: r.recommendation,
    regime: r.regime,
    schemaVersion: r.schemaVersion,
    analysisHash: r.analysisHash,
    analysis: safeParse(r.signalBreakdown),
  }));
}

/**
 * Delete rows older than `retentionDays`. Returns the count of deleted
 * rows. Best-effort: any failure is logged and surfaced via the return
 * value (caller can decide whether to alert).
 *
 * TODO (Phase 16 — paper trading): exclude symbols with open paper
 * trades from the prune so we never lose the historical context for an
 * active position. Will join against the PaperTrade table when that
 * model exists.
 */
export async function pruneOldRecommendations(): Promise<number> {
  const cutoff = new Date(
    Date.now() - RECOMMENDATION_LOG_CONFIG.retentionDays * 86_400_000
  );
  try {
    const r = await db.recommendationLog.deleteMany({
      where: { timestamp: { lt: cutoff } },
    });
    return r.count;
  } catch (err) {
    log.warn("audit-log", "prune.failure", { error: err });
    return 0;
  }
}

function parseDate(v: Date | string | undefined): Date | null {
  if (v === undefined) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Forward-compat shield: if a future schema change makes a row
    // un-parseable, return the raw string so the caller at least sees
    // something rather than crashing. Logged for observability.
    log.warn("audit-log", "read.parse-failure", {
      sample: raw.slice(0, 100),
    });
    return { _raw: raw };
  }
}
