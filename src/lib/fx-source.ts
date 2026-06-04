// Phase 13 — FX rate source (edge module).
//
// Pulls the daily USD→EUR reference rate from Frankfurter
// (https://api.frankfurter.app, which wraps the ECB daily reference
// rate feed). Free, no auth, no rate limits beyond best-effort.
//
// Cache strategy: one row per (date, fromCurrency, toCurrency) in the
// FxRate table. The daily cron upserts today's rate; older rows are
// preserved so peildatum snapshots can later recompute against the
// rate as it was on that exact date.
//
// All failures (network, HTTP, JSON parse) log a warn and return null
// / empty. This module never throws — a missed FX update degrades the
// Box 3 panel to "stale rate" but never breaks the fetcher.

import { db } from "./db";
import { log } from "./logger";
import { BOX3_CONFIG } from "./config";

const FRANKFURTER_BASE = "https://api.frankfurter.app";

// Subset of the Frankfurter response we depend on. Documented at
// https://www.frankfurter.app/docs/ — the API returns:
//   { amount, base, date, rates: { EUR: 0.92 } }
interface FrankfurterLatestResponse {
  amount?: number;
  base?: string;
  date?: string; // ISO YYYY-MM-DD
  rates?: Record<string, number>;
}

/**
 * Parse Frankfurter's YYYY-MM-DD date string into a UTC-midnight
 * Date. Returns null when malformed.
 */
function parseEcbDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  // Use the explicit YYYY-MM-DDT00:00:00Z form so we land on UTC
  // midnight regardless of the host's local timezone.
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Fetch the latest USD→EUR rate from Frankfurter, persist a row in
 * the FxRate table. Returns the persisted rate value, or null on any
 * failure. Cron-safe: this is the function the scheduler calls.
 */
export async function refreshUsdEurRate(): Promise<number | null> {
  const from = BOX3_CONFIG.baseCurrency;
  const to = BOX3_CONFIG.quoteCurrency;
  log.info("fx", "refresh.start", { pair: `${from}/${to}` });

  let res: Response;
  try {
    res = await fetch(
      `${FRANKFURTER_BASE}/latest?from=${from}&to=${to}`
    );
  } catch (err) {
    log.warn("fx", "fetch.network-error", { error: err });
    return null;
  }
  if (!res.ok) {
    log.warn("fx", "fetch.http-error", {
      status: res.status,
      statusText: res.statusText,
    });
    return null;
  }

  let body: FrankfurterLatestResponse;
  try {
    body = (await res.json()) as FrankfurterLatestResponse;
  } catch (err) {
    log.warn("fx", "fetch.parse-error", { error: err });
    return null;
  }

  if (!body.date || !body.rates) {
    log.warn("fx", "fetch.malformed", { body });
    return null;
  }
  const rate = body.rates[to];
  if (typeof rate !== "number" || !Number.isFinite(rate)) {
    log.warn("fx", "fetch.malformed", { reason: "rate missing or not finite" });
    return null;
  }
  const date = parseEcbDate(body.date);
  if (!date) {
    log.warn("fx", "fetch.malformed", { reason: "date unparseable", date: body.date });
    return null;
  }

  try {
    await db.fxRate.upsert({
      where: {
        date_fromCurrency_toCurrency: {
          date,
          fromCurrency: from,
          toCurrency: to,
        },
      },
      update: { rate, fetchedAt: new Date() },
      create: { date, fromCurrency: from, toCurrency: to, rate },
    });
  } catch (err) {
    log.warn("fx", "persist.failure", { error: err });
    return null;
  }

  log.info("fx", "refresh.done", { date: body.date, rate });
  return rate;
}

/**
 * Read the most recent USD→EUR rate from the cache. Returns null when
 * there's no data at all (cold start before the first cron tick). The
 * caller (box3-source) decides how to handle the null: surface a
 * "rate unavailable" state to the UI rather than hard-failing.
 */
export async function getLatestUsdEurRate(): Promise<{
  rate: number;
  date: Date;
} | null> {
  const row = await db.fxRate.findFirst({
    where: {
      fromCurrency: BOX3_CONFIG.baseCurrency,
      toCurrency: BOX3_CONFIG.quoteCurrency,
    },
    orderBy: { date: "desc" },
  });
  if (!row) return null;
  return { rate: row.rate, date: row.date };
}
