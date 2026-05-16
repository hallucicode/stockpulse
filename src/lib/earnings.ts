// Phase 3 — earnings calendar (pure module).
//
// Per CLAUDE.md "Pure core, side effects at edges":
//   - This file has only pure functions: imminence math, recommendation
//     adjustment, score nudging.
//   - The actual Finnhub HTTP call + DB writes live in `./earnings-source.ts`
//     (the edge module).
//
// Goal: holding a position through earnings is a coin flip on an unknowable
// catalyst. If the scanner is going to suggest BUYs, it must at least KNOW
// that earnings are imminent and reflect that risk in both the score and the
// recommendation. This module provides the deterministic adjustment.

import type { Analysis, EarningsInfo } from "@/types";
import { EARNINGS_CONFIG, type EarningsConfig } from "./config";

const MS_PER_DAY = 86_400_000;

/**
 * Whole-day difference between two dates, ignoring time-of-day. Negative when
 * `target` is in the past. Returns NaN for invalid input — callers must
 * tolerate that (real callers use `getNextEarnings` which already filters).
 */
export function daysUntil(target: Date | string, now: Date): number {
  const t = typeof target === "string" ? new Date(target) : target;
  if (!Number.isFinite(t.getTime())) return Number.NaN;
  // Compare at UTC midnight so a 23:59-vs-00:01 nanosecond doesn't flip days.
  const dayMs = MS_PER_DAY;
  const t0 = Math.floor(t.getTime() / dayMs) * dayMs;
  const n0 = Math.floor(now.getTime() / dayMs) * dayMs;
  return Math.round((t0 - n0) / dayMs);
}

/** True if an earnings event is within the imminence window (and not past). */
export function isImminent(
  eventDate: Date | string,
  now: Date,
  thresholdDays: number = EARNINGS_CONFIG.imminenceCalendarDays
): boolean {
  const d = daysUntil(eventDate, now);
  if (!Number.isFinite(d)) return false;
  return d >= 0 && d <= thresholdDays;
}

/**
 * From a list of upcoming events for a single symbol, pick the next one
 * (closest in the future, including today). Returns null if none.
 *
 * Pure function — `now` is injected for determinism.
 */
export function getNextEarnings(
  events: { date: Date | string; epsEstimate?: number | null; hour?: string | null }[],
  now: Date
): EarningsInfo | null {
  let best: { date: Date; daysUntilEvent: number; epsEstimate?: number; hour?: string } | null = null;
  for (const e of events) {
    const d = typeof e.date === "string" ? new Date(e.date) : e.date;
    if (!Number.isFinite(d.getTime())) continue;
    const days = daysUntil(d, now);
    if (days < 0) continue;
    if (best === null || days < best.daysUntilEvent) {
      best = {
        date: d,
        daysUntilEvent: days,
        epsEstimate: e.epsEstimate ?? undefined,
        hour: e.hour ?? undefined,
      };
    }
  }
  if (!best) return null;
  return {
    nextDate: best.date.toISOString().split("T")[0],
    daysUntil: best.daysUntilEvent,
    imminent: best.daysUntilEvent <= EARNINGS_CONFIG.imminenceCalendarDays,
    epsEstimate: best.epsEstimate,
    hour: best.hour,
  };
}

/** One-tier downgrade ladder, used when earnings are imminent. */
export function downgradeRecommendation(
  rec: Analysis["recommendation"]
): Analysis["recommendation"] {
  switch (rec) {
    case "STRONG BUY":
      return "BUY";
    case "BUY":
      return "HOLD";
    case "HOLD":
      return "SELL"; // imminent earnings + already a HOLD → lean defensive
    case "SELL":
      return "STRONG SELL";
    case "STRONG SELL":
      return "STRONG SELL";
  }
}

/**
 * Decorate an analysis with earnings information and (when imminent) apply
 * the score nudge + recommendation downgrade.
 *
 * Pure: returns a new Analysis object, never mutates the input.
 */
export function applyEarningsAdjustment(
  analysis: Analysis,
  earnings: EarningsInfo | null,
  config: EarningsConfig = EARNINGS_CONFIG
): Analysis {
  if (!earnings) return analysis;

  // Always attach the earnings info — the UI uses it to render the badge
  // even when the event is outside the imminence window (just informational).
  if (!earnings.imminent) {
    return { ...analysis, earnings };
  }

  const nudgedScore = clamp(
    analysis.compositeScore + config.scoreAdjustment,
    -100,
    100
  );
  const nudgedRecommendation = config.applyRecommendationDowngrade
    ? downgradeRecommendation(analysis.recommendation)
    : analysis.recommendation;

  return {
    ...analysis,
    compositeScore: nudgedScore,
    recommendation: nudgedRecommendation,
    earnings,
    signals: [
      ...analysis.signals,
      {
        label: "Earnings Imminent",
        detail: `Reports in ${earnings.daysUntil} day${earnings.daysUntil === 1 ? "" : "s"} — holding through earnings is high-variance`,
        type: "neutral",
        weight: config.scoreAdjustment,
      },
    ],
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
