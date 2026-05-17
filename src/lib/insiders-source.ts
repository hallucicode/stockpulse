// Phase 5 — insider transactions source (edge module).
//
// I/O lives here; pure decision logic lives in `./insiders.ts`. Same
// throttling pattern as news/fundamentals (serial 1.1s, 60/min cap).
//
// Provider: Finnhub `/stock/insider-transactions`. The plan called for SEC
// EDGAR Form 4 directly, but Finnhub already has the same data normalised,
// our key already works there, and using one provider keeps rate-limit
// arithmetic trivial. EDGAR direct is a viable future alternative if
// Finnhub coverage becomes a problem.

import { db } from "./db";
import { log } from "./logger";
import { INSIDERS_CONFIG } from "./config";
import { finnhubFetch, getFinnhubKey } from "./finnhub";
import { serialThrottle, type ThrottleStepResult } from "./throttle";
import type { InsiderTxn } from "./insiders";

interface FinnhubInsiderRow {
  name: string;
  share?: number;
  change?: number;
  filingDate?: string;
  transactionDate?: string;
  transactionCode?: string;
  transactionPrice?: number;
}

interface FinnhubInsiderResponse {
  data?: FinnhubInsiderRow[];
  symbol?: string;
}

type FetchResult =
  | { status: "ok"; rows: FinnhubInsiderRow[] }
  | { status: "rate_limited" }
  | { status: "error" };

function isoDay(d: Date): string {
  return d.toISOString().split("T")[0];
}

async function fetchInsidersForSymbol(symbol: string): Promise<FetchResult> {
  const to = new Date();
  const from = new Date(
    to.getTime() - INSIDERS_CONFIG.lookbackDays * 86_400_000
  );
  const result = await finnhubFetch<FinnhubInsiderResponse>(
    "/stock/insider-transactions",
    { symbol, from: isoDay(from), to: isoDay(to) }
  );
  switch (result.status) {
    case "no_key":
      log.warn("insiders", "fetch.no-key-mid-loop", { symbol });
      return { status: "error" };
    case "rate_limited":
      log.warn("insiders", "fetch.rate-limited", { symbol });
      return { status: "rate_limited" };
    case "error":
      log.warn("insiders", "fetch.error", { symbol, error: result.error });
      return { status: "error" };
    case "ok":
      return {
        status: "ok",
        rows: Array.isArray(result.data?.data) ? result.data.data : [],
      };
  }
}

async function persistInsiders(
  symbol: string,
  rows: FinnhubInsiderRow[]
): Promise<void> {
  for (const r of rows) {
    if (!r.transactionDate || !r.name) continue;
    const change = typeof r.change === "number" ? r.change : 0;
    if (change === 0) continue; // ignore zero-change records (typically option exercises that net out)
    const price =
      typeof r.transactionPrice === "number" && Number.isFinite(r.transactionPrice)
        ? r.transactionPrice
        : null;
    const totalValue = price !== null ? Math.abs(change) * price : null;
    const transactionDate = new Date(r.transactionDate);
    if (!Number.isFinite(transactionDate.getTime())) continue;
    try {
      await db.insiderTransaction.upsert({
        where: {
          symbol_filerName_transactionDate_shareChange: {
            symbol,
            filerName: r.name,
            transactionDate,
            shareChange: change,
          },
        },
        update: {
          transactionCode: r.transactionCode ?? null,
          price,
          totalValue,
        },
        create: {
          symbol,
          filerName: r.name,
          transactionDate,
          transactionCode: r.transactionCode ?? null,
          shareChange: change,
          price,
          totalValue,
        },
      });
    } catch (err) {
      log.warn("insiders", "upsert.failure", { symbol, name: r.name, error: err });
    }
  }
  // Trim rows older than the lookback window — keeps the table small.
  const cutoff = new Date(
    Date.now() - INSIDERS_CONFIG.lookbackDays * 86_400_000
  );
  await db.insiderTransaction.deleteMany({
    where: { symbol, transactionDate: { lt: cutoff } },
  });
}

export async function refreshAllInsiders(): Promise<{
  total: number;
  succeeded: number;
  rateLimited: number;
  errored: number;
  duration: number;
}> {
  if (!getFinnhubKey()) {
    log.info("insiders", "refresh.skip.no-key");
    return {
      total: 0,
      succeeded: 0,
      rateLimited: 0,
      errored: 0,
      duration: 0,
    };
  }
  const watchlist = await db.watchlistStock.findMany({
    orderBy: { addedAt: "asc" },
  });
  log.info("insiders", "refresh.start", { count: watchlist.length });

  const summary = await serialThrottle({
    items: watchlist,
    spacingMs: INSIDERS_CONFIG.requestSpacingMs,
    rateLimitBackoffMs: INSIDERS_CONFIG.rateLimitBackoffMs,
    progressEveryN: INSIDERS_CONFIG.progressLogEveryN,
    onProgress: (p) => log.info("insiders", "refresh.progress", p),
    run: async (stock): Promise<ThrottleStepResult> => {
      const result = await fetchInsidersForSymbol(stock.symbol);
      if (result.status === "rate_limited") return { kind: "rate_limited" };
      if (result.status === "error") return { kind: "error" };
      try {
        await persistInsiders(stock.symbol, result.rows);
        return { kind: "ok" };
      } catch (err) {
        log.warn("insiders", "persist.failure", {
          symbol: stock.symbol,
          error: err,
        });
        return { kind: "error" };
      }
    },
  });

  log.info("insiders", "refresh.done", {
    succeeded: summary.succeeded,
    rateLimited: summary.rateLimited,
    errored: summary.errored,
    total: summary.total,
    durationMs: summary.durationMs,
  });
  return {
    total: summary.total,
    succeeded: summary.succeeded,
    rateLimited: summary.rateLimited,
    errored: summary.errored,
    duration: summary.durationMs,
  };
}

/**
 * DB-cached read used by the per-stock decoration step. Returns plain
 * `InsiderTxn` shape consumed by the pure module.
 */
export async function getRecentInsiderTxnsForSymbol(
  symbol: string
): Promise<InsiderTxn[]> {
  const cutoff = new Date(
    Date.now() - INSIDERS_CONFIG.lookbackDays * 86_400_000
  );
  const rows = await db.insiderTransaction.findMany({
    where: { symbol, transactionDate: { gte: cutoff } },
    orderBy: { transactionDate: "desc" },
  });
  return rows.map((r) => ({
    filerName: r.filerName,
    transactionDate: r.transactionDate,
    transactionCode: r.transactionCode,
    shareChange: r.shareChange,
    totalValue: r.totalValue,
  }));
}
