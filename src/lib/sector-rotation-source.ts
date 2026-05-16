// Phase 7.1 — sector rotation source (edge module).
//
// Per CLAUDE.md "Pure core, side effects at edges": this module owns
// Yahoo Finance reads + DB writes. The classification math lives in
// `./sector-rotation.ts` (pure).
//
// Cadence: one snapshot per ETF per refresh (daily). History is preserved
// so a future /sectors page can chart rotation over time, and Phase 11
// backtests can replay deterministically.

import { db } from "./db";
import { log } from "./logger";
import { getHistory } from "./market-data";
import { SECTOR_ETF_MAP, SECTOR_ROTATION_CONFIG } from "./config";
import { classifySectorRotation } from "./sector-rotation";
import type { SectorRotationInfo, SectorRotationState } from "@/types";

/**
 * Fetch each sector ETF's history, classify rotation state, persist one
 * snapshot per sector. Returns the number of sectors successfully refreshed.
 *
 * Per-sector failure is non-fatal — one bad ETF read shouldn't block the
 * rest of the daily refresh. Each failure logs structured `error:` so the
 * /logs page surfaces it.
 */
export async function refreshSectorRotation(): Promise<number> {
  const cfg = SECTOR_ROTATION_CONFIG;
  const sectors = Object.entries(SECTOR_ETF_MAP);
  log.info("sector-rotation", "refresh.start", { sectors: sectors.length });

  let succeeded = 0;
  for (const [sector, etfSymbol] of sectors) {
    try {
      const history = await getHistory(etfSymbol, cfg.historyDays);
      if (history.length < cfg.smaPeriod) {
        log.warn("sector-rotation", "refresh.insufficient-data", {
          sector,
          etfSymbol,
          bars: history.length,
        });
        continue;
      }
      const classified = classifySectorRotation(history, cfg);
      if (!classified) {
        log.warn("sector-rotation", "refresh.classify-null", {
          sector,
          etfSymbol,
        });
        continue;
      }

      await db.sectorSnapshot.create({
        data: {
          sector,
          etfSymbol,
          state: classified.state,
          close: classified.close,
          sma200: classified.sma200,
          // Persist both side run lengths explicitly so the UI/audit can
          // show "30 bars above after 47 below" without re-running the
          // classifier. recentUpBars is the *up* side regardless of
          // current state — derived from which side we're on now.
          recentUpBars:
            classified.state === "turning_up" ||
            classified.state === "trending_up"
              ? classified.recentRunBars
              : classified.state === "turning_down" ||
                  classified.state === "trending_down"
                ? classified.priorOppositeRunBars
                : 0,
          priorDownBars:
            classified.state === "turning_up"
              ? classified.priorOppositeRunBars
              : classified.state === "trending_down" ||
                  classified.state === "turning_down"
                ? classified.recentRunBars
                : 0,
        },
      });
      succeeded++;
    } catch (err) {
      log.error("sector-rotation", "refresh.error", {
        sector,
        etfSymbol,
        error: err,
      });
    }
  }

  log.info("sector-rotation", "refresh.done", {
    succeeded,
    total: sectors.length,
  });
  return succeeded;
}

/**
 * Look up the latest snapshot for each sector. Returns a map of
 * sector-key → SectorRotationInfo, omitting sectors with no snapshot yet
 * (cold start). Stocks in those sectors will simply not get the catalyst
 * — better than asserting "no rotation" before the cron has run.
 */
export async function getCurrentSectorRotationMap(): Promise<
  Map<string, SectorRotationInfo>
> {
  const map = new Map<string, SectorRotationInfo>();
  for (const sector of Object.keys(SECTOR_ETF_MAP)) {
    const row = await db.sectorSnapshot.findFirst({
      where: { sector },
      orderBy: { fetchedAt: "desc" },
    });
    if (!row) continue;
    map.set(sector, {
      state: row.state as SectorRotationState,
      etfSymbol: row.etfSymbol,
      close: row.close,
      sma200: row.sma200,
      // Whichever run length corresponds to the current state.
      recentRunBars:
        row.state === "turning_up" || row.state === "trending_up"
          ? row.recentUpBars
          : row.state === "turning_down" || row.state === "trending_down"
            ? row.priorDownBars
            : Math.max(row.recentUpBars, row.priorDownBars),
    });
  }
  return map;
}
