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
import type { InsiderTxn } from "./insiders";

const FINNHUB_BASE = "https://finnhub.io/api/v1";

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

function getApiKey(): string | undefined {
  const k = process.env.FINNHUB_API_KEY;
  return k && k.length > 0 ? k : undefined;
}

function isoDay(d: Date): string {
  return d.toISOString().split("T")[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchInsidersForSymbol(
  symbol: string,
  apiKey: string
): Promise<FetchResult> {
  const to = new Date();
  const from = new Date(
    to.getTime() - INSIDERS_CONFIG.lookbackDays * 86_400_000
  );
  const url =
    `${FINNHUB_BASE}/stock/insider-transactions` +
    `?symbol=${encodeURIComponent(symbol)}&from=${isoDay(from)}&to=${isoDay(to)}&token=${apiKey}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    log.warn("insiders", "fetch.network-error", { symbol, error: err });
    return { status: "error" };
  }
  if (res.status === 429) {
    log.warn("insiders", "fetch.rate-limited", { symbol });
    return { status: "rate_limited" };
  }
  if (!res.ok) {
    log.warn("insiders", "fetch.http-error", {
      symbol,
      status: res.status,
      statusText: res.statusText,
    });
    return { status: "error" };
  }
  const data = (await res.json()) as FinnhubInsiderResponse;
  return { status: "ok", rows: Array.isArray(data?.data) ? data.data : [] };
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
  const start = Date.now();
  const apiKey = getApiKey();
  if (!apiKey) {
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

  let succeeded = 0;
  let rateLimited = 0;
  let errored = 0;

  for (let i = 0; i < watchlist.length; i++) {
    const stock = watchlist[i];
    const result = await fetchInsidersForSymbol(stock.symbol, apiKey);
    if (result.status === "ok") {
      try {
        await persistInsiders(stock.symbol, result.rows);
        succeeded++;
      } catch (err) {
        log.warn("insiders", "persist.failure", { symbol: stock.symbol, error: err });
        errored++;
      }
    } else if (result.status === "rate_limited") {
      rateLimited++;
      await sleep(INSIDERS_CONFIG.rateLimitBackoffMs);
    } else {
      errored++;
    }
    const processed = i + 1;
    if (processed % INSIDERS_CONFIG.progressLogEveryN === 0) {
      log.info("insiders", "refresh.progress", {
        processed,
        total: watchlist.length,
        succeeded,
        rateLimited,
        errored,
      });
    }
    if (i < watchlist.length - 1) {
      await sleep(INSIDERS_CONFIG.requestSpacingMs);
    }
  }

  const duration = Date.now() - start;
  log.info("insiders", "refresh.done", {
    succeeded,
    rateLimited,
    errored,
    total: watchlist.length,
    durationMs: duration,
  });
  return { total: watchlist.length, succeeded, rateLimited, errored, duration };
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
