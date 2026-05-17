// Phase 3 — earnings calendar source (edge module).
//
// Per CLAUDE.md "Pure core, side effects at edges": this file owns the I/O
// (HTTP to Finnhub + DB writes). All decision logic — imminence, score
// nudging, recommendation downgrade — lives in `./earnings.ts` (pure).
//
// Provider: Finnhub free tier (60 req/min). Endpoint:
//   GET /api/v1/calendar/earnings?from=YYYY-MM-DD&to=YYYY-MM-DD&token=KEY
//
// Graceful degradation:
//   - No API key → log once and skip the cron. The system runs as before;
//     analyses simply have no `earnings` field. UI hides the badge.
//   - Network failure → logged and surfaced via `log.error`; next refresh
//     retries normally.

import { db } from "./db";
import { log } from "./logger";
import { EARNINGS_CONFIG } from "./config";
import { getNextEarnings } from "./earnings";
import { finnhubFetch, getFinnhubKey } from "./finnhub";
import type { EarningsInfo } from "@/types";

interface FinnhubEarningsRow {
  symbol: string;
  date: string; // "YYYY-MM-DD"
  epsEstimate?: number | null;
  hour?: string | null;
}

interface FinnhubEarningsResponse {
  earningsCalendar?: FinnhubEarningsRow[];
}

function isoDay(d: Date): string {
  return d.toISOString().split("T")[0];
}

/**
 * Fetch the calendar between two dates (inclusive). Returns rows from
 * Finnhub or an empty array on missing key / network failure.
 *
 * Uses the shared `finnhubFetch` envelope (Phase 10) so the no-key,
 * network-error and 429 paths are handled centrally — caller just sees
 * an empty array on any non-ok outcome.
 */
export async function fetchEarningsCalendar(
  from: Date,
  to: Date
): Promise<FinnhubEarningsRow[]> {
  const result = await finnhubFetch<FinnhubEarningsResponse>(
    "/calendar/earnings",
    { from: isoDay(from), to: isoDay(to) }
  );
  if (result.status === "no_key") {
    log.info("earnings", "skip.no-key");
    return [];
  }
  if (result.status === "rate_limited") {
    log.warn("earnings", "fetch.rate-limited");
    return [];
  }
  if (result.status === "error") {
    log.warn("earnings", "fetch.error", { error: result.error });
    return [];
  }
  return result.data.earningsCalendar ?? [];
}

/**
 * Daily refresh job: pull the next `fetchHorizonDays` from Finnhub and upsert
 * into `EarningsEvent`. Old rows past their date are not deleted — they're
 * harmless and serve as a small audit history.
 *
 * Returns the number of rows upserted (0 when no API key).
 */
export async function refreshEarningsCalendar(): Promise<number> {
  if (!getFinnhubKey()) {
    log.info("earnings", "refresh.skip.no-key");
    return 0;
  }
  const now = new Date();
  const horizon = new Date(now.getTime() + EARNINGS_CONFIG.fetchHorizonDays * 86_400_000);

  log.info("earnings", "refresh.start", { from: isoDay(now), to: isoDay(horizon) });

  const rows = await fetchEarningsCalendar(now, horizon);
  if (rows.length === 0) {
    log.info("earnings", "refresh.empty");
    return 0;
  }

  let count = 0;
  for (const row of rows) {
    if (!row.symbol || !row.date) continue;
    const date = new Date(row.date);
    if (!Number.isFinite(date.getTime())) continue;
    try {
      await db.earningsEvent.upsert({
        where: { symbol_date: { symbol: row.symbol, date } },
        update: {
          epsEstimate: row.epsEstimate ?? null,
          hour: row.hour ?? null,
          fetchedAt: new Date(),
        },
        create: {
          symbol: row.symbol,
          date,
          epsEstimate: row.epsEstimate ?? null,
          hour: row.hour ?? null,
        },
      });
      count++;
    } catch (err) {
      // Per-row failure is non-fatal — log and continue.
      log.warn("earnings", "upsert.failure", {
        symbol: row.symbol,
        date: row.date,
        error: err,
      });
    }
  }

  log.info("earnings", "refresh.done", { upserted: count });
  return count;
}

/**
 * Look up the next earnings event for a single symbol from the local DB.
 * Returns null when no future events are recorded.
 *
 * Cheap (indexed lookup) — safe to call once per ticker per refresh cycle.
 */
export async function getNextEarningsForSymbol(
  symbol: string,
  now: Date = new Date()
): Promise<EarningsInfo | null> {
  const events = await db.earningsEvent.findMany({
    where: { symbol, date: { gte: startOfDay(now) } },
    orderBy: { date: "asc" },
    take: 5,
  });
  if (events.length === 0) return null;
  return getNextEarnings(events, now);
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}
