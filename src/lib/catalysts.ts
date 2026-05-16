// Phase 7 — catalyst aggregation (pure module).
//
// Per CLAUDE.md "Pure core, side effects at edges": no I/O here. The
// orchestrator decorates an Analysis with the upstream catalyst-shaped
// fields (earnings, insiders, analysts, diagnosis) and then calls this
// module to aggregate them into a confidence indicator.
//
// Design decisions documented in CATALYST_CONFIG (see ./config.ts):
//   - We **do not** modify `compositeScore` here. Phases 3/4/5 already
//     nudge the score when their individual signals fire; multiplying the
//     catalyst total back into the score would double-count those nudges.
//   - The `score` field is still exposed so the UI can sort by catalyst
//     density and so Phase 11 backtest can experiment with using it as a
//     direct booster (gated on evidence).

import type {
  Analysis,
  CatalystInfo,
  CatalystType,
  DiagnosisCategory,
  SectorRotationState,
} from "@/types";
import { CATALYST_CONFIG, type CatalystConfig } from "./config";

export interface CatalystInput {
  earnings?: { daysUntil: number } | null;
  insiders?: { hasClusterBuy: boolean } | null;
  analysts?: { recentUpgrades: number } | null;
  diagnosis?: { category: DiagnosisCategory } | null;
  // Phase 7.1 — sector rotation state for the symbol's sector.
  sectorRotation?: { state: SectorRotationState } | null;
}

/**
 * Pure aggregation. Given an analysis's catalyst-shaped fields, return
 * the list of active catalysts, their summed weight, and the confidence
 * count. Same input → same output, no clock reads.
 */
export function evaluateCatalysts(
  input: CatalystInput,
  cfg: CatalystConfig = CATALYST_CONFIG
): CatalystInfo {
  const present: CatalystType[] = [];
  let score = 0;

  // 1. Upcoming earnings within the catalyst window. We deliberately use
  //    `>= 0 && <= window` (not `imminent`) so that a known earnings 14
  //    days out — too far to count as a Phase 3 *risk* but still a
  //    tradeable event — registers as a catalyst.
  if (
    input.earnings &&
    input.earnings.daysUntil >= 0 &&
    input.earnings.daysUntil <= cfg.earningsCatalystWindowDays
  ) {
    present.push("earnings_upcoming");
    score += cfg.weights.earnings_upcoming;
  }

  // 2. Cluster insider buying (≥2 distinct insiders in 14 days, per
  //    INSIDERS_CONFIG). Single highest-alpha catalyst — weighted heaviest.
  if (input.insiders?.hasClusterBuy) {
    present.push("insider_cluster");
    score += cfg.weights.insider_cluster;
  }

  // 3. Recent analyst upgrade. We count any upgrade in the score-boost
  //    window (`AnalystActivity.recentUpgrades > 0`); a downgrade alongside
  //    doesn't cancel — the catalyst event is the upgrade itself, and the
  //    downgrade penalty is already applied in `applyAnalystAdjustment`.
  if (input.analysts && input.analysts.recentUpgrades > 0) {
    present.push("analyst_upgrade");
    score += cfg.weights.analyst_upgrade;
  }

  // 4. Positive-news catalyst (Phase 4 diagnosis in a positive bucket).
  //    Uses a config-driven list so adding a new positive category is a
  //    one-line config change, not a code change here.
  if (
    input.diagnosis &&
    (cfg.positiveNewsCategories as readonly DiagnosisCategory[]).includes(
      input.diagnosis.category
    )
  ) {
    present.push("positive_news");
    score += cfg.weights.positive_news;
  }

  // 5. Sector rotation (Phase 7.1) — only the bullish *turning_up*
  //    transition fires the catalyst. Sectors merely trending up have
  //    already had the catalyst play out; flat / trending_down / turning_down
  //    sectors don't deserve a bullish nudge.
  if (input.sectorRotation?.state === "turning_up") {
    present.push("sector_rotation");
    score += cfg.weights.sector_rotation;
  }

  return {
    score,
    present,
    confidence: present.length,
  };
}

/**
 * Decorate an Analysis with its CatalystInfo. Pure: returns a new object,
 * never mutates the input. Deliberately does NOT modify `compositeScore`
 * — see the module docstring for the double-counting rationale.
 */
export function applyCatalystAdjustment(
  analysis: Analysis,
  cfg: CatalystConfig = CATALYST_CONFIG
): Analysis {
  const info = evaluateCatalysts(
    {
      earnings: analysis.earnings ?? null,
      insiders: analysis.insiders ?? null,
      analysts: analysis.analysts ?? null,
      diagnosis: analysis.diagnosis ?? null,
      sectorRotation: analysis.sectorRotation ?? null,
    },
    cfg
  );
  return { ...analysis, catalysts: info };
}
