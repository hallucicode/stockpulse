// Phase 14 — "Why cheap?" rationale builder.
//
// Generates the human-readable one-liner under the trade card header. Pure
// function over the already-computed analysis: no LLM, no I/O. Falls back to
// `null` when nothing meaningful can be said — the UI hides the row in that
// case rather than printing a vacuous "Technical setup" line that gives the
// user no information.
//
// Order matters: the cascade walks the most diagnostic signals first
// (specific news category > sector rotation > regime > technical pullback).
// First match wins.

import type { Analysis } from "@/types";

/**
 * Returns a short sentence explaining *why* this stock is at a price worth
 * a long entry — or null when no diagnostic signal supports a rationale.
 *
 * Never invents reasons. If the only signal is "RSI looks oversold" with
 * nothing else, that's not enough to claim a "why" — return null and let
 * the indicators speak for themselves.
 */
export function buildWhyCheap(analysis: Analysis): string | null {
  // 1. News-driven "stock is mechanically cheap because sector got hit".
  //    Highest-specificity rationale we have without an LLM.
  if (analysis.diagnosis?.category === "sector_selloff") {
    return "Sector-wide selloff — likely temporary, not company-specific";
  }

  // 2. Other negative-but-recoverable news categories. We *don't* trigger
  //    on fraud / guidance_cut / lawsuit — those are red flags, not
  //    "cheap for a good reason" setups.
  if (analysis.diagnosis?.category === "earnings_miss") {
    return "Recent earnings miss — re-entry candidate once price stabilises";
  }
  if (analysis.diagnosis?.category === "analyst_downgrade") {
    return "Analyst downgrade priced in — watch for follow-through";
  }

  // 3. Sector rotation turning back up — Phase 7.1 catalyst window.
  if (analysis.sectorRotation?.state === "turning_up") {
    return `Sector rotating back up after a downtrend (${analysis.sectorRotation.etfSymbol})`;
  }

  // 4. Regime-driven rationale: if the broad market is trending down and
  //    this name is still showing buy signals, it's a relative-strength
  //    play. Otherwise no regime statement is informative.
  if (analysis.regime?.regime === "trending_down") {
    return "Holding up against a falling broad market — relative strength";
  }

  // 5. Pure technical pullback, no news flag. Only meaningful when the
  //    diagnosis is explicitly technical_only (i.e. we *did* check news and
  //    found nothing material) — not when diagnosis is undefined (cache
  //    might just be cold).
  if (
    analysis.diagnosis?.category === "technical_only" &&
    analysis.dayChange < 0
  ) {
    return "Technical pullback, no fundamental flags";
  }

  // 6. Catalyst window opening — earnings or insider cluster coming. Only
  //    valid as the *primary* rationale when there's nothing more specific.
  if (analysis.catalysts && analysis.catalysts.confidence >= 2) {
    return "Multiple catalysts aligning";
  }

  return null;
}
