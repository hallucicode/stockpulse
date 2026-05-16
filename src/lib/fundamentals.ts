// Phase 4.5 — fundamentals filter (pure module).
//
// Pure per CLAUDE.md "Pure core, side effects at edges": this file decides,
// given a `Fundamentals` snapshot already fetched from the DB, whether the
// stock fails one of the hard quality rules. The orchestrator
// (background-fetcher) does the DB read; this file does the math.
//
// What's NOT here:
//   - HTTP / Finnhub I/O (lives in `fundamentals-source.ts`).
//   - Any UI concerns. The veto is shaped like Phase 2.5's `QualityVeto`
//     so it slots into the same `Analysis.qualityVeto` field and the
//     scanner's existing filter logic hides the stock automatically.
//
// Order of rules in `evaluateFundamentals` matters. First match wins —
// chosen so the most informative reason surfaces when multiple apply.

import type { Analysis, Fundamentals, QualityVeto } from "@/types";
import { FUNDAMENTALS_CONFIG } from "./config";

/**
 * Heuristic for "Finnhub returned a row but the row is empty enough that we
 * can't make any decision". When this is true we veto with
 * `unknown_fundamentals` (better to under-recommend than to recommend
 * trash) per IMPLEMENTATION_PLAN.md.
 */
function isMissingCriticalData(f: Fundamentals): boolean {
  return f.epsTtm === null && f.marketCap === null;
}

function fmtMillions(usd: number): string {
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(1)}B`;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  return `$${usd.toFixed(0)}`;
}

/**
 * Decide whether a stock should be vetoed based on its fundamentals.
 * Returns the first matching veto, or null when the stock passes.
 */
export function evaluateFundamentals(f: Fundamentals): QualityVeto | null {
  const cfg = FUNDAMENTALS_CONFIG;

  // 1. No usable data at all — only fires when Finnhub returned a row but
  //    the core fields are blank. Cold-start (no row at all) is handled by
  //    the orchestrator skipping this check entirely.
  if (isMissingCriticalData(f)) {
    return {
      reason: "unknown_fundamentals",
      detail:
        "Fundamentals data unavailable from Finnhub — not enough info to verify this is a real, viable company",
    };
  }

  // 2. Must have earnings — the user-stated bar. Even loss-makers count IF
  //    they file an earnings report; what we want to filter are tickers
  //    that aren't real public companies (e.g. some OTC names, ETFs, dead
  //    listings) and have no reported EPS at all.
  if (!f.hasReportedEarnings || f.epsTtm === null) {
    return {
      reason: "no_earnings",
      detail:
        "Company has not reported earnings (TTM EPS missing) — not a tradeable corporate name",
    };
  }

  // 3. Microcap by market cap — too thin/manipulable.
  if (f.marketCap !== null && f.marketCap < cfg.microcapThresholdUsd) {
    return {
      reason: "microcap",
      detail: `Market cap ${fmtMillions(f.marketCap)} is below the ${fmtMillions(cfg.microcapThresholdUsd)} floor`,
    };
  }

  // 4. Cash-burning — losses AND shrinking. Loss-makers in growth mode are
  //    fine; loss-makers in decline are bankruptcy candidates.
  if (
    f.epsTtm < 0 &&
    f.revenueGrowthYoy !== null &&
    f.revenueGrowthYoy < 0
  ) {
    return {
      reason: "cash_burning",
      detail: `Loss-making (EPS ${f.epsTtm.toFixed(2)}) and shrinking (revenue ${f.revenueGrowthYoy.toFixed(1)}% YoY)`,
    };
  }

  // 5. Catastrophic leverage — one bad quarter from default.
  if (f.debtToEquity !== null && f.debtToEquity > cfg.maxDebtToEquity) {
    return {
      reason: "over_leveraged",
      detail: `Debt/equity ratio ${f.debtToEquity.toFixed(1)} exceeds the ${cfg.maxDebtToEquity}× cap`,
    };
  }

  return null;
}

/**
 * Apply a fundamentals-based veto to an Analysis. Pure: returns a new
 * Analysis without mutating the input. Existing `qualityVeto` (from Phase
 * 2.5 price-based gates) takes precedence — we don't overwrite a more
 * specific upstream reason.
 */
export function applyFundamentalsAdjustment(
  analysis: Analysis,
  fundamentals: Fundamentals | null
): Analysis {
  // Cold start: no row in DB, we haven't even tried to fetch this symbol.
  // Don't veto — wait for the next refresh.
  if (fundamentals === null) return analysis;

  // Don't override a Phase 2.5 veto (penny stock, illiquid, etc.) —
  // upstream is more specific and the user has already seen that label
  // in the audit log.
  if (analysis.qualityVeto) return analysis;

  const veto = evaluateFundamentals(fundamentals);
  if (!veto) return analysis;
  return { ...analysis, qualityVeto: veto };
}
