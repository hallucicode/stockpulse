// Phase 5 — insider activity (pure module).
//
// Pure per CLAUDE.md "Pure core, side effects at edges". The orchestrator
// (background-fetcher) reads transactions from the DB and passes them in;
// this file decides whether the activity adds up to a cluster buy and
// computes the score nudge.
//
// "Cluster buy" definition: ≥`clusterMinDistinctBuyers` distinct insiders
// making open-market purchases (transaction code "P" or, when missing,
// positive shareChange) within `clusterWindowDays`. This is the single
// strongest individual-name signal in finance — execs buying with their
// own money, in numbers, in a short window.

import type {
  Analysis,
  InsiderActivity,
} from "@/types";
import { INSIDERS_CONFIG, RECOMMENDATION_THRESHOLDS } from "./config";

export interface InsiderTxn {
  filerName: string;
  transactionDate: Date;
  transactionCode: string | null;
  shareChange: number;
  totalValue: number | null;
}

/**
 * A transaction counts as an "open-market buy" if either:
 *   - the SEC code is explicitly "P" (purchase), OR
 *   - the code is missing/blank but the share change is positive
 *     (Finnhub sometimes omits the code; sign of change is the fallback).
 *
 * We exclude option exercises (M), grants (A), gifts (G), etc. — those
 * aren't bullish insider conviction signals.
 */
function isOpenMarketBuy(t: InsiderTxn): boolean {
  if (t.shareChange <= 0) return false;
  if (!t.transactionCode) return true; // permissive when code missing
  return t.transactionCode === "P";
}

export function evaluateInsiderActivity(
  transactions: InsiderTxn[],
  now: Date = new Date()
): InsiderActivity {
  const cfg = INSIDERS_CONFIG;
  const dayMs = 86_400_000;

  const clusterCutoff = new Date(now.getTime() - cfg.clusterWindowDays * dayMs);
  const boostCutoff = new Date(now.getTime() - cfg.scoreBoostLookbackDays * dayMs);

  const buys = transactions.filter(isOpenMarketBuy);
  const clusterBuys = buys.filter((t) => t.transactionDate >= clusterCutoff);
  const distinctBuyers = new Set(clusterBuys.map((t) => t.filerName)).size;
  const hasClusterBuy = distinctBuyers >= cfg.clusterMinDistinctBuyers;

  const recentBuys = buys.filter((t) => t.transactionDate >= boostCutoff);
  const recentBuyValueUsd = recentBuys.reduce(
    (sum, t) => sum + (t.totalValue ?? 0),
    0
  );

  const lastBuy =
    buys.length === 0
      ? null
      : buys.reduce((a, b) =>
          a.transactionDate > b.transactionDate ? a : b
        );

  return {
    hasClusterBuy,
    clusterBuyerCount: distinctBuyers,
    recentBuyValueUsd,
    lastBuyAt: lastBuy?.transactionDate.toISOString() ?? null,
    // Only the cluster signal moves the score. A single buy isn't enough,
    // and sells are too noisy (executives often sell for diversification).
    scoreAdjustment: hasClusterBuy ? cfg.clusterBuyScoreBoost : 0,
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

/**
 * Apply insider activity to an Analysis. Pure: returns new Analysis,
 * never mutates input. Recomputes recommendation when score moves.
 */
export function applyInsiderAdjustment(
  analysis: Analysis,
  activity: InsiderActivity
): Analysis {
  if (activity.scoreAdjustment === 0) {
    // Still attach so the UI can render "no cluster" with last-buy date.
    return { ...analysis, insiders: activity };
  }
  const newScore = clampScore(analysis.compositeScore + activity.scoreAdjustment);
  return {
    ...analysis,
    compositeScore: newScore,
    recommendation: scoreToRecommendation(newScore),
    insiders: activity,
  };
}
