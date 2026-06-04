// Phase 13 — Box 3 helper source (edge module).
//
// Orchestrates open positions × latest analysis prices × latest FX
// rate, feeds the trio into `./box3.ts` (pure), and exposes:
//   1. computeCurrentValuation() — live valuation + Box 3 estimate
//   2. takeSnapshot({ label?, effectiveDate? }) — persist a permanent
//      Box3Snapshot row for peildatum reporting
//   3. listSnapshots() — read history (most-recent first)
//
// No HTTP I/O here — the FX rate is fetched separately by the
// fx-source cron and read from cache. This module is purely a
// composer of in-process data.

import { db } from "./db";
import { log } from "./logger";
import {
  computePortfolioValueEur,
  estimateBox3Liability,
  type Box3Estimate,
  type PortfolioValuation,
  type PositionForValuation,
} from "./box3";
import { getLatestUsdEurRate } from "./fx-source";
import { BOX3_CONFIG } from "./config";

interface AnalysisCacheData {
  analysis?: {
    price?: number;
  };
}

/**
 * Parsed price for one symbol pulled from the AnalysisCache JSON
 * blob. Returns null when the cache row is missing or the JSON
 * doesn't carry a usable price.
 */
async function getCurrentPrice(symbol: string): Promise<number | null> {
  const row = await db.analysisCache.findUnique({ where: { symbol } });
  if (!row) return null;
  try {
    const data = JSON.parse(row.data) as AnalysisCacheData;
    const price = data.analysis?.price;
    if (typeof price === "number" && Number.isFinite(price)) return price;
    return null;
  } catch {
    return null;
  }
}

interface OpenPosition {
  symbol: string;
  shares: number;
  buyPrice: number;
}

async function loadOpenPositions(): Promise<OpenPosition[]> {
  const rows = await db.position.findMany({
    where: { status: "open" },
    orderBy: { buyDate: "asc" },
  });
  return rows.map((r) => ({
    symbol: r.symbol,
    shares: r.shares,
    buyPrice: r.buyPrice,
  }));
}

export type ValuationResult =
  | {
      kind: "ok";
      valuation: PortfolioValuation;
      estimate: Box3Estimate;
      asOf: Date;
      /** True when the FX cron hasn't populated a row yet. */
      fxStale: false;
    }
  | {
      kind: "no-fx-rate";
      /** Last-known rate date, or null if we've never had a row. */
      lastFxRateDate: null;
    };

/**
 * Compute a live portfolio valuation + Box 3 estimate using the most
 * recent USD/EUR rate in cache. Returns a discriminated result so the
 * caller (API route) can decide how to render the no-rate state.
 *
 * Per-position prices fall back to `buyPrice` when the analysis cache
 * doesn't carry a current quote (the pure module flags those rows so
 * the UI can show "stale" badges).
 */
export async function computeCurrentValuation(): Promise<ValuationResult> {
  const fx = await getLatestUsdEurRate();
  if (!fx) {
    return { kind: "no-fx-rate", lastFxRateDate: null };
  }

  const openPositions = await loadOpenPositions();
  const positionsForValuation: PositionForValuation[] = await Promise.all(
    openPositions.map(async (p) => ({
      symbol: p.symbol,
      shares: p.shares,
      currentPriceUsd: await getCurrentPrice(p.symbol),
      buyPriceUsd: p.buyPrice,
    }))
  );

  const valuation = computePortfolioValueEur(
    positionsForValuation,
    fx.rate
  );
  const estimate = estimateBox3Liability(valuation.totalValueEur);

  return {
    kind: "ok",
    valuation,
    estimate,
    asOf: fx.date,
    fxStale: false,
  };
}

export interface TakeSnapshotOptions {
  /** Human-readable label ("Jan 1 2026", "End of Q1", etc.). */
  label?: string;
  /**
   * The peildatum the snapshot represents. Defaults to today (UTC).
   * The FX rate used is still the latest cached rate — for true
   * "as of Jan 1 2026" accuracy, the snapshot would have to be taken
   * on or near that date.
   */
  effectiveDate?: Date;
}

/**
 * Persist the current valuation as a Box3Snapshot row. Append-only:
 * multiple snapshots for the same date are allowed (e.g. one
 * "automatic" and one "after manual adjustments"); `label`
 * distinguishes them.
 *
 * Returns the persisted row's id and the valuation used. Errors
 * propagate to the caller (the API route surfaces a 500).
 */
export async function takeSnapshot(
  opts: TakeSnapshotOptions = {}
): Promise<{ id: string; valuation: ValuationResult }> {
  const valuation = await computeCurrentValuation();
  if (valuation.kind !== "ok") {
    throw new Error(
      "Cannot snapshot without an FX rate — wait for the fx.refresh cron to populate one."
    );
  }
  const date = opts.effectiveDate ?? new Date();
  const taxYear = BOX3_CONFIG.taxYear;
  const label = opts.label ?? "";

  const row = await db.box3Snapshot.create({
    data: {
      date,
      taxYear,
      label,
      totalValueUsd: valuation.valuation.totalValueUsd,
      totalValueEur: valuation.valuation.totalValueEur,
      usdEurRate: valuation.valuation.usdEurRate,
      perPositionJson: JSON.stringify(valuation.valuation.positions),
    },
  });

  log.info("box3", "snapshot.taken", {
    id: row.id,
    taxYear,
    totalValueEur: valuation.valuation.totalValueEur,
  });

  return { id: row.id, valuation };
}

export interface SnapshotRow {
  id: string;
  date: string;
  taxYear: number;
  label: string;
  totalValueUsd: number;
  totalValueEur: number;
  usdEurRate: number;
  createdAt: string;
}

/**
 * Return the snapshot history, most-recent first by snapshot date.
 * Doesn't include the per-position JSON blob (the listing UI doesn't
 * need it; a future "snapshot detail" endpoint can fetch a single
 * row).
 */
export async function listSnapshots(): Promise<SnapshotRow[]> {
  const rows = await db.box3Snapshot.findMany({
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    date: r.date.toISOString(),
    taxYear: r.taxYear,
    label: r.label,
    totalValueUsd: r.totalValueUsd,
    totalValueEur: r.totalValueEur,
    usdEurRate: r.usdEurRate,
    createdAt: r.createdAt.toISOString(),
  }));
}
