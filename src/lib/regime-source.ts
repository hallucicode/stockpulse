// Phase 6 — market regime source (edge module).
//
// Per CLAUDE.md "Pure core, side effects at edges": this file owns the
// I/O (Yahoo Finance reads for SPY + VIX, DB writes for the snapshot).
// All decision logic — classifier, ADX math, percentile — lives in
// `./regime.ts` (pure).
//
// The regime cron runs daily. One snapshot per refresh; we keep history
// in the DB so a future /regime page can chart it. The per-stock
// orchestrator (`background-fetcher.ts`) reads the latest snapshot and
// passes it through `applyRegimeAdjustment` for every analysis.

import { db } from "./db";
import { log } from "./logger";
import { getHistory } from "./market-data";
import { REGIME_CONFIG } from "./config";
import { calcADX, classifyRegime, percentileOf } from "./regime";
import type { Regime } from "@/types";

function simpleSMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] ?? 0;
  return (
    values.slice(-period).reduce((a, b) => a + b, 0) / period
  );
}

/**
 * Fetch SPY + VIX history, compute the regime, persist one snapshot.
 * Returns the new regime, or null when data is missing / partial.
 */
export async function refreshRegimeSnapshot(): Promise<Regime | null> {
  const cfg = REGIME_CONFIG;
  log.info("regime", "refresh.start");

  let spyHistory: Awaited<ReturnType<typeof getHistory>>;
  let vixHistory: Awaited<ReturnType<typeof getHistory>>;
  try {
    [spyHistory, vixHistory] = await Promise.all([
      getHistory(cfg.spySymbol, cfg.historyDays),
      getHistory(cfg.vixSymbol, cfg.historyDays),
    ]);
  } catch (err) {
    log.error("regime", "refresh.fetch-error", { error: err });
    return null;
  }

  if (spyHistory.length < cfg.smaPeriod || vixHistory.length < 30) {
    log.warn("regime", "refresh.insufficient-data", {
      spyBars: spyHistory.length,
      vixBars: vixHistory.length,
    });
    return null;
  }

  // SPY metrics
  const spyCloses = spyHistory.map((b) => b.close);
  const spyClose = spyCloses[spyCloses.length - 1];
  const spy200dma = simpleSMA(spyCloses, cfg.smaPeriod);
  const adx14 = calcADX(spyHistory, cfg.adxPeriod);

  // VIX metrics
  const vixCloses = vixHistory.map((b) => b.close);
  const vixLevel = vixCloses[vixCloses.length - 1];
  const vixPercentile = percentileOf(vixLevel, vixCloses);

  const regime = classifyRegime({
    spyClose,
    spy200dma,
    adx14,
    vixLevel,
    vixPercentile,
  });

  try {
    await db.regimeSnapshot.create({
      data: {
        regime,
        spyClose,
        spy200dma,
        adx14,
        vixLevel,
        vixPercentile,
      },
    });
  } catch (err) {
    log.warn("regime", "persist.failure", { error: err });
  }

  log.info("regime", "refresh.done", {
    regime,
    spyClose: Number(spyClose.toFixed(2)),
    spy200dma: Number(spy200dma.toFixed(2)),
    adx14: Number(adx14.toFixed(2)),
    vixLevel: Number(vixLevel.toFixed(2)),
    vixPercentile: Number(vixPercentile.toFixed(1)),
  });
  return regime;
}

/**
 * Read the most recent snapshot's regime label. Returns null when no
 * snapshot has been persisted yet (cold start) — orchestrator treats
 * null as "skip the adjustment" (don't penalise analyses before the
 * regime cron has run).
 */
export async function getCurrentRegime(): Promise<Regime | null> {
  const row = await db.regimeSnapshot.findFirst({
    orderBy: { fetchedAt: "desc" },
  });
  if (!row) return null;
  return row.regime as Regime;
}
