// Phase 14 — regime / recommendation compatibility check.
//
// Drives the ✓ / ⚠ icon next to the regime label in the trade card. A buy
// signal in a `trending_down` regime is a *headwind* setup — possibly still
// valid (counter-trend bounces happen), but the user should know the broad
// market is fighting the thesis. Same logic in reverse for sells in
// `trending_up`.
//
// Pure function over (recommendation, regime). No I/O.

import type { Analysis, Regime } from "@/types";

export interface RegimeFitResult {
  /**
   * True when the regime supports (or at minimum doesn't fight) the
   * recommendation. False when it's a headwind setup.
   */
  ok: boolean;
  /**
   * Short human-readable note. Empty string when ok is true and there's
   * nothing notable to say. Non-empty for the ⚠ tooltip.
   */
  note: string;
}

const BUY_RECS = new Set<Analysis["recommendation"]>(["STRONG BUY", "BUY"]);
const SELL_RECS = new Set<Analysis["recommendation"]>(["STRONG SELL", "SELL"]);

/**
 * Decide whether the current regime fits the recommendation.
 *
 *   - High-vol crisis is a headwind for *every* recommendation — the right
 *     play is usually "stay flat", not "execute the signal".
 *   - Buy signals in trending_down regimes: headwind.
 *   - Sell signals in trending_up regimes: headwind.
 *   - Anything else: ok.
 *
 * HOLD always returns ok=true with an empty note — there's nothing to
 * action, so there's no headwind to flag.
 *
 * When regime info is missing (older cache entry), returns
 * `{ ok: true, note: "" }` — be lenient with stale data rather than
 * spuriously flagging every card with ⚠.
 */
export function regimeFitsSignal(
  recommendation: Analysis["recommendation"],
  regime: Regime | undefined
): RegimeFitResult {
  if (!regime) return { ok: true, note: "" };
  if (recommendation === "HOLD") return { ok: true, note: "" };

  if (regime === "high_vol_crisis") {
    return {
      ok: false,
      note: "High-volatility regime — sizing should be reduced or skipped",
    };
  }

  if (BUY_RECS.has(recommendation) && regime === "trending_down") {
    return {
      ok: false,
      note: "Buy signal in a downtrending market — counter-trend trade",
    };
  }

  if (SELL_RECS.has(recommendation) && regime === "trending_up") {
    return {
      ok: false,
      note: "Sell signal in an uptrending market — counter-trend trade",
    };
  }

  return { ok: true, note: "" };
}
