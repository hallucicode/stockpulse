// Phase 5 — analyst rating actions source (edge module).
//
// Provider: yahoo-finance2 `quoteSummary({ modules: ["upgradeDowngradeHistory"] })`.
//
// Why Yahoo, not Finnhub:
//   Finnhub's `/stock/upgrade-downgrade` requires a paid plan (HTTP 403 on
//   the free tier). Yahoo exposes the same per-firm/per-action data via
//   the `quoteSummary` endpoint we already authenticate against for prices.
//   Same field set: firm name, fromGrade, toGrade, action, date — so
//   downstream pure modules (`./analysts.ts`) and the schema stay
//   unchanged.
//
// Trade-off accepted: yahoo-finance2 is unofficial — same risk profile we
// already accept for `getHistory`. If Yahoo changes their schema we'll
// notice it the same way we'd notice price-data breakage.

import YahooFinance from "yahoo-finance2";
import { db } from "./db";
import { log } from "./logger";
import { ANALYSTS_CONFIG } from "./config";
import type { AnalystEvent } from "./analysts";

const yf = new YahooFinance();

// Yahoo's upgradeDowngradeHistory item shape (subset we read).
interface YfHistoryItem {
  epochGradeDate?: Date | string | number;
  firm?: string;
  toGrade?: string;
  fromGrade?: string;
  action?: string;
}

type FetchResult =
  | { status: "ok"; rows: YfHistoryItem[] }
  | { status: "error" };

async function fetchAnalystsForSymbol(
  symbol: string
): Promise<FetchResult> {
  try {
    const result = await yf.quoteSummary(symbol, {
      modules: ["upgradeDowngradeHistory"],
    });
    const history =
      (result as { upgradeDowngradeHistory?: { history?: YfHistoryItem[] } })
        ?.upgradeDowngradeHistory?.history ?? [];
    return { status: "ok", rows: history };
  } catch (err) {
    log.warn("analysts", "fetch.error", { symbol, error: err });
    return { status: "error" };
  }
}

function toDate(v: Date | string | number | undefined): Date | null {
  if (v === undefined) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v === "number") {
    // Yahoo sometimes uses unix seconds, sometimes ms; normalise.
    const d = new Date(v < 1e12 ? v * 1000 : v);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

async function persistAnalysts(
  symbol: string,
  rows: YfHistoryItem[]
): Promise<void> {
  for (const r of rows) {
    if (!r.action || !r.firm) continue;
    const publishedAt = toDate(r.epochGradeDate);
    if (!publishedAt) continue;
    try {
      await db.analystAction.upsert({
        where: {
          symbol_firm_publishedAt_action: {
            symbol,
            firm: r.firm,
            publishedAt,
            action: r.action,
          },
        },
        update: {
          fromGrade: r.fromGrade ?? null,
          toGrade: r.toGrade ?? null,
        },
        create: {
          symbol,
          firm: r.firm,
          publishedAt,
          action: r.action,
          fromGrade: r.fromGrade ?? null,
          toGrade: r.toGrade ?? null,
        },
      });
    } catch (err) {
      log.warn("analysts", "upsert.failure", {
        symbol,
        firm: r.firm,
        error: err,
      });
    }
  }
  // Trim rows older than the lookback window.
  const cutoff = new Date(
    Date.now() - ANALYSTS_CONFIG.lookbackDays * 86_400_000
  );
  await db.analystAction.deleteMany({
    where: { symbol, publishedAt: { lt: cutoff } },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function refreshAllAnalysts(): Promise<{
  total: number;
  succeeded: number;
  errored: number;
  duration: number;
}> {
  const start = Date.now();
  const watchlist = await db.watchlistStock.findMany({
    orderBy: { addedAt: "asc" },
  });
  log.info("analysts", "refresh.start", { count: watchlist.length });

  let succeeded = 0;
  let errored = 0;

  for (let i = 0; i < watchlist.length; i++) {
    const stock = watchlist[i];
    const result = await fetchAnalystsForSymbol(stock.symbol);
    if (result.status === "ok") {
      try {
        await persistAnalysts(stock.symbol, result.rows);
        succeeded++;
      } catch (err) {
        log.warn("analysts", "persist.failure", {
          symbol: stock.symbol,
          error: err,
        });
        errored++;
      }
    } else {
      errored++;
    }
    const processed = i + 1;
    if (processed % ANALYSTS_CONFIG.progressLogEveryN === 0) {
      log.info("analysts", "refresh.progress", {
        processed,
        total: watchlist.length,
        succeeded,
        errored,
      });
    }
    if (i < watchlist.length - 1) {
      await sleep(ANALYSTS_CONFIG.requestSpacingMs);
    }
  }

  const duration = Date.now() - start;
  log.info("analysts", "refresh.done", {
    succeeded,
    errored,
    total: watchlist.length,
    durationMs: duration,
  });
  return { total: watchlist.length, succeeded, errored, duration };
}

export async function getRecentAnalystActionsForSymbol(
  symbol: string
): Promise<AnalystEvent[]> {
  const cutoff = new Date(
    Date.now() - ANALYSTS_CONFIG.lookbackDays * 86_400_000
  );
  const rows = await db.analystAction.findMany({
    where: { symbol, publishedAt: { gte: cutoff } },
    orderBy: { publishedAt: "desc" },
  });
  return rows.map((r) => ({
    firm: r.firm,
    fromGrade: r.fromGrade,
    toGrade: r.toGrade,
    action: r.action,
    publishedAt: r.publishedAt,
  }));
}
