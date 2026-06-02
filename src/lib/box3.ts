// Phase 13 — Box 3 helper (pure module).
//
// Per CLAUDE.md "Pure core, side effects at edges": this file owns all
// the deterministic math behind the Box 3 helper. The edge module
// (`./box3-source.ts`) reads positions + prices + FX rates and feeds
// them in; this file just does the arithmetic.
//
// Three jobs:
//   1. USD → EUR conversion of single values.
//   2. Portfolio valuation: aggregate open positions × prices × FX
//      rate into a total + per-position breakdown, with explicit
//      warning flags for positions that don't have a current price.
//   3. Box 3 estimate: given the portfolio EUR value plus the
//      Belastingdienst's deemed-return / threshold / rate constants,
//      project the annual liability.
//
// **Estimate, not advice.** The number this module produces is a
// ballpark for sanity-checking — it doesn't model assets-vs-debts
// netting, partner-pooling, asset-category nuances beyond `overige
// bezittingen`, or any of the case-law-driven edge cases. The UI
// labels every derived figure with that caveat.

import { BOX3_CONFIG, type Box3Config } from "./config";

/**
 * Convert a USD amount to EUR at the given rate, rounded to cents.
 *
 * Rounding to two decimals matches how the Belastingdienst expects
 * values and avoids floating-point noise being shown to the user.
 * Edge cases: NaN/Infinity rate or amount return NaN — callers
 * should fall back to a sentinel or warn upstream.
 */
export function convertUsdToEur(amountUsd: number, usdEurRate: number): number {
  if (!Number.isFinite(amountUsd) || !Number.isFinite(usdEurRate)) {
    return Number.NaN;
  }
  return Math.round(amountUsd * usdEurRate * 100) / 100;
}

export interface PositionForValuation {
  symbol: string;
  shares: number;
  /** Falls back to `buyPrice` when null (with a warn flag set on the row). */
  currentPriceUsd: number | null;
  /** Used as the fallback when `currentPriceUsd` is null. */
  buyPriceUsd: number;
}

export interface PositionValuation {
  symbol: string;
  shares: number;
  /** The price used in the math — either currentPriceUsd or buyPriceUsd. */
  effectivePriceUsd: number;
  valueUsd: number;
  valueEur: number;
  /** True when `currentPriceUsd` was null and we used `buyPriceUsd`
   *  as a stale fallback. UI flags this so the operator knows the
   *  position's market value is potentially out of date. */
  usedFallbackPrice: boolean;
}

export interface PortfolioValuation {
  /** Same date as the input FX rate; rate captures the as-of moment. */
  usdEurRate: number;
  totalValueUsd: number;
  totalValueEur: number;
  /** Per-position breakdown in input order. */
  positions: PositionValuation[];
  /** Convenience — number of positions where we fell back to buyPrice. */
  fallbackCount: number;
}

/**
 * Aggregate a list of open positions into a total portfolio
 * valuation in USD and EUR. Pure: same inputs → same output.
 *
 * Behaviour on missing data:
 *   - A position with `currentPriceUsd === null` uses `buyPriceUsd`
 *     and sets `usedFallbackPrice: true` so the UI can surface the
 *     staleness.
 *   - An empty input list returns zeros (not an error) — the caller
 *     decides how to render an empty portfolio.
 */
export function computePortfolioValueEur(
  positions: PositionForValuation[],
  usdEurRate: number
): PortfolioValuation {
  let totalValueUsd = 0;
  let fallbackCount = 0;
  const breakdown: PositionValuation[] = positions.map((p) => {
    const usedFallback = p.currentPriceUsd === null;
    if (usedFallback) fallbackCount++;
    const effectivePriceUsd =
      p.currentPriceUsd === null ? p.buyPriceUsd : p.currentPriceUsd;
    const valueUsd = effectivePriceUsd * p.shares;
    const valueEur = convertUsdToEur(valueUsd, usdEurRate);
    totalValueUsd += valueUsd;
    return {
      symbol: p.symbol,
      shares: p.shares,
      effectivePriceUsd,
      valueUsd,
      valueEur,
      usedFallbackPrice: usedFallback,
    };
  });
  const totalValueEur = convertUsdToEur(totalValueUsd, usdEurRate);
  return {
    usdEurRate,
    totalValueUsd,
    totalValueEur,
    positions: breakdown,
    fallbackCount,
  };
}

export interface Box3Estimate {
  /** Reflects what the user has — same as input. */
  totalValueEur: number;
  /** Heffingsvrij vermogen applied. */
  heffingsvrijVermogen: number;
  /** Portion subject to Box 3 (totalValueEur minus heffingsvrij, floor 0). */
  taxableBaseEur: number;
  /** Deemed return rate applied. */
  deemedReturnRate: number;
  /** Deemed annual return in EUR (taxableBase × deemedReturnRate). */
  deemedReturnEur: number;
  /** Tax rate applied to the deemed return. */
  taxRate: number;
  /** Estimated Box 3 liability in EUR. */
  estimatedTaxEur: number;
  /** Tax year these rates apply to (from config). */
  taxYear: number;
}

/**
 * Back-of-envelope Box 3 liability estimate.
 *
 * Math: `max(0, totalValueEur − heffingsvrij)` × deemedReturnRate ×
 * taxRate.
 *
 * Deliberately under-models the real calculation — see the module
 * docstring for everything this doesn't handle. UI must show this
 * with an "estimate — not tax advice" caveat next to it.
 */
export function estimateBox3Liability(
  totalValueEur: number,
  cfg: Box3Config = BOX3_CONFIG
): Box3Estimate {
  const taxableBaseEur = Math.max(0, totalValueEur - cfg.heffingsvrijVermogen);
  const deemedReturnEur = taxableBaseEur * cfg.deemedReturnRateOverigeBezittingen;
  const estimatedTaxEur = deemedReturnEur * cfg.box3TaxRate;
  return {
    totalValueEur,
    heffingsvrijVermogen: cfg.heffingsvrijVermogen,
    taxableBaseEur,
    deemedReturnRate: cfg.deemedReturnRateOverigeBezittingen,
    deemedReturnEur,
    taxRate: cfg.box3TaxRate,
    estimatedTaxEur,
    taxYear: cfg.taxYear,
  };
}
