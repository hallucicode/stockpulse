// Phase 0 — data-quality firewall.
//
// Pure module per CLAUDE.md "Pure core, side effects at edges":
//   - validateBar / validateHistory / shouldQuarantine are deterministic
//     functions of their inputs. No I/O, no clock reads (the caller passes
//     `now`), no DB writes.
//   - The orchestration layer (background-fetcher) decides what to do with
//     the issues — log to DataQualityLog, skip caching, retry, etc.
//
// Goal: never let bad data reach `analyzeStock`. A scanner that recommends
// BUY on a delisted ticker because its last-known price was low is worse
// than no scanner.
//
// SCOPE FOR v1 (this phase):
//   ✓ structural bar checks (high/low/close consistency, NaN, negatives)
//   ✓ stale-data detection (likely delisted)
//   ✓ halt-run detection (consecutive zero-volume bars)
//   ✓ huge gap flagging (likely unannounced split, possibly real earnings move)
//   ✓ empty/short history detection
//
// DEFERRED:
//   - Cross-source verification (Stooq / Alpha Vantage). Documented in the
//     implementation plan; needs a real API contract decision and is a
//     separate sub-phase.
//   - Corporate-action detection from adjusted-vs-unadjusted close (yahoo
//     returns `adjclose` separately). Once exposed in HistoricalBar we can
//     downgrade huge gaps from "suspicious" to "explained split".

import type { HistoricalBar } from "@/types";
import { DATA_QUALITY_CONFIG } from "./config";

export type Severity = "low" | "medium" | "high" | "critical";

export type IssueType =
  | "empty_history"
  | "short_history"
  | "invalid_bar"
  | "stale_data"
  | "halt_run"
  | "huge_gap";

export interface DataQualityIssue {
  type: IssueType;
  severity: Severity;
  detail: string;
  /** Index into the history array (when applicable). */
  index?: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * Validate a single bar's structural integrity.
 * "critical" = the bar is mathematically nonsense; never use it.
 */
export function validateBar(
  bar: HistoricalBar,
  index?: number
): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  const { open, high, low, close, volume } = bar;

  if (
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close) ||
    !Number.isFinite(volume)
  ) {
    issues.push({
      type: "invalid_bar",
      severity: "critical",
      detail: "Bar contains non-finite numbers",
      index,
    });
    return issues; // further checks meaningless on NaN/Infinity
  }

  if (high < low) {
    issues.push({
      type: "invalid_bar",
      severity: "critical",
      detail: `high (${high}) < low (${low})`,
      index,
    });
  }
  if (close < low || close > high) {
    issues.push({
      type: "invalid_bar",
      severity: "critical",
      detail: `close (${close}) outside [low=${low}, high=${high}]`,
      index,
    });
  }
  if (open < 0 || high < 0 || low < 0 || close < 0) {
    issues.push({
      type: "invalid_bar",
      severity: "critical",
      detail: "Negative price",
      index,
    });
  }
  if (volume < 0) {
    issues.push({
      type: "invalid_bar",
      severity: "critical",
      detail: `Negative volume (${volume})`,
      index,
    });
  }

  return issues;
}

/**
 * Run all data-quality checks on a price history.
 *
 * `now` is injected for testability — callers in production pass `new Date()`,
 * tests pass a fixed clock. Keeping the function pure.
 */
export function validateHistory(
  history: HistoricalBar[],
  now: Date = new Date()
): DataQualityIssue[] {
  const issues: DataQualityIssue[] = [];
  const cfg = DATA_QUALITY_CONFIG;

  if (history.length === 0) {
    issues.push({
      type: "empty_history",
      severity: "high",
      detail: "No bars returned (likely delisted or wrong symbol)",
    });
    return issues;
  }

  if (history.length < cfg.minHistoryBars) {
    issues.push({
      type: "short_history",
      severity: "medium",
      detail: `Only ${history.length} bars (need at least ${cfg.minHistoryBars})`,
    });
  }

  // Per-bar structural checks.
  for (let i = 0; i < history.length; i++) {
    issues.push(...validateBar(history[i], i));
  }

  // Staleness — based on the last bar's timestamp.
  const last = history[history.length - 1];
  const lastDate = new Date(last.date);
  if (Number.isFinite(lastDate.getTime())) {
    const ageDays = (now.getTime() - lastDate.getTime()) / MS_PER_DAY;
    if (ageDays > cfg.staleThresholdDays) {
      issues.push({
        type: "stale_data",
        severity: "high",
        detail: `Last bar is ${ageDays.toFixed(1)} days old (threshold ${cfg.staleThresholdDays})`,
        index: history.length - 1,
      });
    }
  }

  // Halt runs in the recent window.
  const window = history.slice(-cfg.recentBarsToCheck);
  let zeroRun = 0;
  let zeroRunStart = -1;
  for (let i = 0; i < window.length; i++) {
    if (window[i].volume === 0) {
      if (zeroRun === 0) zeroRunStart = history.length - window.length + i;
      zeroRun++;
      if (zeroRun === cfg.haltRunBars) {
        issues.push({
          type: "halt_run",
          severity: "high",
          detail: `${cfg.haltRunBars}+ consecutive zero-volume bars (possible halt or delisting)`,
          index: zeroRunStart,
        });
      }
    } else {
      zeroRun = 0;
      zeroRunStart = -1;
    }
  }

  // Huge gap detection in the recent window.
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1].close;
    const curr = window[i].close;
    if (prev <= 0) continue;
    const pct = ((curr - prev) / prev) * 100;
    if (Math.abs(pct) >= cfg.hugeGapAbsPct) {
      issues.push({
        type: "huge_gap",
        severity: "medium",
        detail: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% close-to-close move (possible split or major event)`,
        index: history.length - window.length + i,
      });
    }
  }

  return issues;
}

/**
 * Quarantine decision: should we refuse to publish this stock to the scanner?
 * We quarantine on `critical` (mathematically broken) or `high` (stale, halted,
 * empty). `medium` issues (huge gaps, short history) are flagged but allowed —
 * a 35% earnings move is real data; phase 4 (news) will explain it.
 */
export function shouldQuarantine(issues: DataQualityIssue[]): boolean {
  return issues.some(
    (i) => i.severity === "critical" || i.severity === "high"
  );
}

/**
 * Convenience: max severity in a list (for sort/display). "low" if empty.
 */
export function maxSeverity(issues: DataQualityIssue[]): Severity {
  const order: Record<Severity, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  let best: Severity = "low";
  for (const i of issues) {
    if (order[i.severity] > order[best]) best = i.severity;
  }
  return best;
}
