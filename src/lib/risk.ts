// Phase 1 — risk module.
//
// Pure functions per CLAUDE.md "Pure core, side effects at edges":
// stop / target / size / guardrail math has no I/O, no clock, no DB.
// All tunables come from `./config` (RISK_CONFIG). The orchestration layer
// (analyzeStock and any future broker integration) decides when to call us.
//
// What this module is NOT (and why):
//   - It does NOT enforce any portfolio-level rules over time. That's Phase 2
//     (drawdown throttle, daily loss limit, consecutive-loser cutoff) — a
//     stateful concern that needs its own module + Prisma table.
//   - It does NOT round to a tick size or worry about minimum lot sizes.
//     Those are execution-layer concerns (Phase 11).

import type { HistoricalBar, RiskLevels, StopMethod } from "@/types";
import { RISK_CONFIG } from "./config";

// ─── ATR ───
// True Range for one bar = max(high − low, |high − prevClose|, |low − prevClose|).
// ATR = simple average of TR over `period` bars.
// Returns 0 when there isn't enough history; callers must handle that.
export function calcATR(
  history: HistoricalBar[],
  period: number = RISK_CONFIG.atrPeriod
): number {
  if (history.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const cur = history[i];
    const prev = history[i - 1];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trs.push(tr);
  }
  const window = trs.slice(-period);
  if (window.length === 0) return 0;
  return window.reduce((a, b) => a + b, 0) / window.length;
}

// ─── Swing low ───
// Lowest low over the last `lookback` bars — used as the structural-stop
// reference. Returns 0 for empty history (callers handle).
export function findSwingLow(
  history: HistoricalBar[],
  lookback: number = RISK_CONFIG.structuralLookback
): number {
  if (history.length === 0) return 0;
  const window = history.slice(-lookback);
  let lo = window[0].low;
  for (const b of window) if (b.low < lo) lo = b.low;
  return lo;
}

// ─── Stop ───
//
// Return the *tightest* of three candidate stops (i.e. the highest price for a
// long position) — that is, the smallest acceptable risk.
//   - ATR stop       — volatility-adjusted breathing room.
//   - Structural     — sits just below recent chart support.
//   - Hard cap       — backstop so we never accept >8% loss.
//
// Taking the maximum of the three means:
//   - If ATR or structural produce a tight stop, we use it (smaller loss).
//   - If both produce a wide stop (e.g. very volatile name), the hard cap
//     overrides so we cap loss at 8%.
export interface StopResult {
  price: number;
  method: StopMethod;
}

export function computeStop(
  entry: number,
  atr: number,
  swingLow: number,
  config = RISK_CONFIG
): StopResult {
  const candidates: StopResult[] = [
    { price: entry - config.atrStopMultiplier * atr, method: "atr" },
    { price: swingLow * config.structuralBuffer, method: "structural" },
    { price: entry * config.hardCapStopFraction, method: "hard_cap" },
  ];
  // Take the highest stop (tightest for a long).
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i].price > best.price) best = candidates[i];
  }
  return best;
}

// ─── Target ───
export function computeTarget(
  entry: number,
  stop: number,
  ratio: number = RISK_CONFIG.riskRewardRatio
): number {
  return entry + (entry - stop) * ratio;
}

// ─── Risk:reward ───
// Returns 0 if risk is non-positive (degenerate stop), keeping callers safe
// from divide-by-zero / negative-risk artefacts.
export function computeRiskReward(
  entry: number,
  stop: number,
  target: number
): number {
  const risk = entry - stop;
  if (risk <= 0) return 0;
  return (target - entry) / risk;
}

// ─── Position sizing ───
//
// Standard fixed-fractional risk: spend (portfolio × riskPct) on the trade,
// distributed across `floor(riskBudget / riskPerShare)` shares.
//
// Returns zeros for any degenerate input (non-positive portfolio / risk-per-
// share / risk-pct). Callers should treat shares=0 as "do not buy".
export interface SizeResult {
  shares: number;
  dollarRisk: number;
  positionValue: number;
  positionPct: number;
}

export function computeSize(params: {
  portfolioValue: number;
  riskPct?: number;
  entry: number;
  stop: number;
}): SizeResult {
  const {
    portfolioValue,
    riskPct = RISK_CONFIG.riskPerTradePct,
    entry,
    stop,
  } = params;
  const riskPerShare = entry - stop;
  if (
    riskPerShare <= 0 ||
    portfolioValue <= 0 ||
    riskPct <= 0 ||
    !Number.isFinite(entry)
  ) {
    return { shares: 0, dollarRisk: 0, positionValue: 0, positionPct: 0 };
  }
  const riskBudget = portfolioValue * riskPct;
  const shares = Math.floor(riskBudget / riskPerShare);
  const positionValue = shares * entry;
  return {
    shares,
    dollarRisk: shares * riskPerShare,
    positionValue,
    positionPct: positionValue / portfolioValue,
  };
}

// ─── Portfolio guardrails ───
//
// Phase 1 scope: per-trade caps (single position %, sector concentration %).
// Drawdown / loss-streak / correlation guardrails are Phase 2 — they need
// portfolio-level historical state.
export interface CandidatePosition {
  symbol: string;
  sector: string;
  shares: number;
  entry: number;
}

export interface ExistingPosition {
  symbol: string;
  sector: string;
  value: number;
}

export interface GuardrailInput {
  candidate: CandidatePosition;
  portfolioValue: number;
  currentPositions: ExistingPosition[];
}

export interface GuardrailResult {
  shares: number;
  reason?: string; // present iff shares were reduced or zeroed
}

export function applyGuardrails(
  input: GuardrailInput,
  config = RISK_CONFIG
): GuardrailResult {
  const { candidate, portfolioValue, currentPositions } = input;
  let shares = candidate.shares;
  if (portfolioValue <= 0 || candidate.entry <= 0 || shares <= 0) {
    return { shares: 0, reason: "invalid input" };
  }

  // ── Single-position cap ──
  const positionValue = shares * candidate.entry;
  const maxPositionValue = portfolioValue * config.maxPositionPct;
  if (positionValue > maxPositionValue) {
    shares = Math.floor(maxPositionValue / candidate.entry);
    if (shares <= 0) return { shares: 0, reason: "single-position cap" };
    return { shares, reason: "single-position cap" };
  }

  // ── Sector cap ──
  const sectorValueExisting = currentPositions
    .filter((p) => p.sector === candidate.sector)
    .reduce((sum, p) => sum + p.value, 0);
  const maxSectorValue = portfolioValue * config.maxSectorPct;
  const sectorValueAfter = sectorValueExisting + shares * candidate.entry;
  if (sectorValueAfter > maxSectorValue) {
    const allowedAdd = maxSectorValue - sectorValueExisting;
    if (allowedAdd <= 0) return { shares: 0, reason: "sector cap reached" };
    shares = Math.floor(allowedAdd / candidate.entry);
    if (shares <= 0) return { shares: 0, reason: "sector cap reached" };
    return { shares, reason: "sector cap" };
  }

  return { shares };
}

// ─── End-to-end risk packet ───
//
// Convenience: given a price history, produce the full RiskLevels packet
// attached to every Analysis. Always returns finite numbers; if history is
// degenerate, returns a "no trade" packet (entry=0, stop=0, etc).
export function deriveRiskLevels(history: HistoricalBar[]): RiskLevels {
  if (history.length === 0) {
    return {
      atr: 0,
      entry: 0,
      stop: 0,
      stopMethod: "hard_cap",
      target: 0,
      riskReward: 0,
    };
  }
  const last = history[history.length - 1];
  const entry = last.close;
  const atr = calcATR(history);
  const swingLow = findSwingLow(history);
  const stopResult = computeStop(entry, atr, swingLow);
  const target = computeTarget(entry, stopResult.price);
  const riskReward = computeRiskReward(entry, stopResult.price, target);
  return {
    atr,
    entry,
    stop: stopResult.price,
    stopMethod: stopResult.method,
    target,
    riskReward,
  };
}
