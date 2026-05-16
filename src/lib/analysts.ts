// Phase 5 — analyst rating actions (pure module).
//
// Pure decision: given a list of recent rating actions for a symbol, count
// upgrades vs downgrades in the score-boost window, surface the most
// recent action for the UI, and compute a small bidirectional nudge.
//
// Score logic: upgrade and downgrade boosts are applied independently and
// summed. So one upgrade alone = +10; one downgrade alone = -10; one of
// each = 0 (mixed signal). This is intentionally conservative — analyst
// actions are noisy and the categorical badge already conveys direction.

import type { Analysis, AnalystActivity } from "@/types";
import { ANALYSTS_CONFIG, RECOMMENDATION_THRESHOLDS } from "./config";

export interface AnalystEvent {
  firm: string;
  fromGrade: string | null;
  toGrade: string | null;
  /** "up" | "down" | "init" | "main" — Finnhub's vocabulary. */
  action: string;
  publishedAt: Date;
}

export function evaluateAnalystActivity(
  actions: AnalystEvent[],
  now: Date = new Date()
): AnalystActivity {
  const cfg = ANALYSTS_CONFIG;
  const cutoff = new Date(
    now.getTime() - cfg.scoreBoostLookbackDays * 86_400_000
  );
  const recent = actions.filter((a) => a.publishedAt >= cutoff);
  const upgrades = recent.filter((a) => a.action === "up").length;
  const downgrades = recent.filter((a) => a.action === "down").length;

  // Most recent action (across the window) for UI display.
  const latestAction =
    recent.length === 0
      ? null
      : recent.reduce((a, b) => (a.publishedAt > b.publishedAt ? a : b));

  // Independent boosts per direction: presence of upgrade adds the boost,
  // presence of downgrade adds its (negative) boost. Mixed = 0.
  const scoreAdjustment =
    (upgrades > 0 ? cfg.upgradeScoreBoost : 0) +
    (downgrades > 0 ? cfg.downgradeScoreBoost : 0);

  return {
    recentUpgrades: upgrades,
    recentDowngrades: downgrades,
    latest: latestAction
      ? {
          firm: latestAction.firm,
          action: latestAction.action,
          fromGrade: latestAction.fromGrade,
          toGrade: latestAction.toGrade,
          date: latestAction.publishedAt.toISOString(),
        }
      : null,
    scoreAdjustment,
  };
}

function clampScore(score: number): number {
  if (score > 100) return 100;
  if (score < -100) return -100;
  return score;
}

function scoreToRecommendation(score: number): Analysis["recommendation"] {
  if (score >= RECOMMENDATION_THRESHOLDS.strongBuy) return "STRONG BUY";
  if (score >= RECOMMENDATION_THRESHOLDS.buy) return "BUY";
  if (score > RECOMMENDATION_THRESHOLDS.sell) return "HOLD";
  if (score > RECOMMENDATION_THRESHOLDS.strongSell) return "SELL";
  return "STRONG SELL";
}

export function applyAnalystAdjustment(
  analysis: Analysis,
  activity: AnalystActivity
): Analysis {
  if (activity.scoreAdjustment === 0) {
    return { ...analysis, analysts: activity };
  }
  const newScore = clampScore(analysis.compositeScore + activity.scoreAdjustment);
  return {
    ...analysis,
    compositeScore: newScore,
    recommendation: scoreToRecommendation(newScore),
    analysts: activity,
  };
}
