// Phase 12 — openFDA source (edge module).
//
// Daily fetch of recently-approved drug applications from openFDA's
// `/drug/drugsfda.json`. Matches each approval against the
// Healthcare-sector portion of the watchlist (two-tier matching, see
// `./fda.ts`) and persists one `FdaEvent` per (symbol, application,
// date). The per-stock decorator in `background-fetcher.ts` reads
// these rows and produces the `FdaActivity` that Phase 7's catalyst
// aggregator consumes.
//
// openFDA gotchas:
//   - The API is free (no key, no rate-limit beyond best-effort), but
//     occasionally HTTP 500s under load. We treat anything other than
//     2xx as a soft failure and continue.
//   - `submission_status_date` is a YYYYMMDD string, not ISO. We parse
//     it explicitly to avoid Date() ambiguity.
//   - `sponsor_name` is uppercase but inconsistent ("MERCK SHARP &
//     DOHME CORP" vs "MERCK SHARP & DOHME LLC"). Matching tolerates
//     this via the pure module's normaliser.

import { db } from "./db";
import { log } from "./logger";
import { FDA_CONFIG } from "./config";
import { findWatchlistMatch } from "./fda";

const OPENFDA_BASE = "https://api.fda.gov/drug/drugsfda.json";

interface OpenFdaSubmission {
  submission_status?: string;        // "AP" for approved
  submission_status_date?: string;   // YYYYMMDD
}

interface OpenFdaResult {
  application_number?: string;
  sponsor_name?: string;
  openfda?: {
    brand_name?: string[];
    generic_name?: string[];
  };
  submissions?: OpenFdaSubmission[];
}

interface OpenFdaResponse {
  results?: OpenFdaResult[];
  // `meta.results.total` exists too but we don't use it.
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoToOpenfdaDate(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function parseOpenfdaDate(yyyymmdd: string): Date | null {
  if (!/^\d{8}$/.test(yyyymmdd)) return null;
  const y = Number(yyyymmdd.slice(0, 4));
  const m = Number(yyyymmdd.slice(4, 6));
  const d = Number(yyyymmdd.slice(6, 8));
  const date = new Date(Date.UTC(y, m - 1, d));
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Build a short human-readable description for an approval. Used in
 * the UI tooltip on the catalyst star and in /logs entries.
 *
 * Examples:
 *   "FDA approval: KEYTRUDA (BLA125514)"
 *   "FDA approval: PEMBROLIZUMAB (BLA125514)"
 *   "FDA approval (BLA125514)"   ← when no brand/generic name
 */
function describeApproval(r: OpenFdaResult): string {
  const brand = r.openfda?.brand_name?.[0];
  const generic = r.openfda?.generic_name?.[0];
  const label = brand ?? generic ?? "";
  const app = r.application_number ? ` (${r.application_number})` : "";
  return label
    ? `FDA approval: ${label}${app}`
    : `FDA approval${app}`.trim();
}

/**
 * Pull approvals from openFDA over the lookback window. Returns an
 * empty array on any error — the cron skips the cycle quietly and
 * tries again tomorrow. Defensive over noisy.
 */
async function fetchRecentApprovals(): Promise<OpenFdaResult[]> {
  const cfg = FDA_CONFIG;
  const to = new Date();
  const from = new Date(to.getTime() - cfg.lookbackDays * 86_400_000);
  const fromStr = isoToOpenfdaDate(from);
  const toStr = isoToOpenfdaDate(to);
  // openFDA query syntax: search field with [range]; AND-combine with `+AND+`.
  const search = `submissions.submission_status:AP+AND+submissions.submission_status_date:[${fromStr}+TO+${toStr}]`;
  const url = `${OPENFDA_BASE}?search=${search}&limit=${cfg.maxResultsPerFetch}`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    log.warn("fda", "fetch.network-error", { error: err });
    return [];
  }
  if (!res.ok) {
    // 404 is the documented "no rows matched" response from openFDA —
    // treat as empty, not error.
    if (res.status === 404) {
      log.info("fda", "fetch.empty");
      return [];
    }
    log.warn("fda", "fetch.http-error", {
      status: res.status,
      statusText: res.statusText,
    });
    return [];
  }
  try {
    const data = (await res.json()) as OpenFdaResponse;
    return Array.isArray(data.results) ? data.results : [];
  } catch (err) {
    log.warn("fda", "fetch.parse-error", { error: err });
    return [];
  }
}

interface RefreshSummary {
  total: number;
  matched: number;
  skippedUnmatched: number;
  errored: number;
  duration: number;
}

/**
 * Daily refresh: pull recent approvals, restrict to Healthcare-sector
 * watchlist entries, persist matched rows. Behaviour-preserving on
 * re-run thanks to the @@unique constraint in the schema (rerunning
 * the same day's data does nothing).
 *
 * Bias-toward-false-negatives: an applicant string that can't be
 * uniquely matched is logged at `info` level and skipped. Operators
 * inspecting /logs can audit "we saw an approval for X but couldn't
 * tie it to a watchlist ticker" without dredging through error noise.
 */
export async function refreshFdaApprovals(): Promise<RefreshSummary> {
  const start = Date.now();
  log.info("fda", "refresh.start");

  const watchlist = await db.watchlistStock.findMany({
    where: { sector: "Healthcare" },
    orderBy: { addedAt: "asc" },
  });
  if (watchlist.length === 0) {
    log.info("fda", "refresh.empty-watchlist");
    return {
      total: 0,
      matched: 0,
      skippedUnmatched: 0,
      errored: 0,
      duration: Date.now() - start,
    };
  }

  const results = await fetchRecentApprovals();

  let matched = 0;
  let skippedUnmatched = 0;
  let errored = 0;

  for (const r of results) {
    if (!r.sponsor_name || !r.application_number || !r.submissions) continue;
    // Find the AP submission within this application (drugsfda groups
    // multiple submission events under one application record).
    const approval = r.submissions.find(
      (s) => s.submission_status === "AP" && s.submission_status_date
    );
    if (!approval || !approval.submission_status_date) continue;

    const date = parseOpenfdaDate(approval.submission_status_date);
    if (!date) continue;

    const match = findWatchlistMatch(r.sponsor_name, watchlist);
    if (!match) {
      skippedUnmatched++;
      log.info("fda", "match.skipped", {
        applicant: r.sponsor_name,
        applicationNumber: r.application_number,
      });
      continue;
    }

    const description = describeApproval(r);
    try {
      await db.fdaEvent.upsert({
        where: {
          symbol_applicationNumber_date: {
            symbol: match.symbol,
            applicationNumber: r.application_number,
            date,
          },
        },
        update: {
          eventType: "approval",
          applicantName: r.sponsor_name,
          description,
          fetchedAt: new Date(),
        },
        create: {
          symbol: match.symbol,
          applicationNumber: r.application_number,
          eventType: "approval",
          date,
          applicantName: r.sponsor_name,
          description,
        },
      });
      matched++;
    } catch (err) {
      errored++;
      log.warn("fda", "upsert.failure", {
        symbol: match.symbol,
        applicationNumber: r.application_number,
        error: err,
      });
    }
  }

  const duration = Date.now() - start;
  log.info("fda", "refresh.done", {
    total: results.length,
    matched,
    skippedUnmatched,
    errored,
    durationMs: duration,
  });
  return {
    total: results.length,
    matched,
    skippedUnmatched,
    errored,
    duration,
  };
}

/**
 * DB-cached read used by the per-stock decoration step in
 * `background-fetcher`. Returns events within the lookback window
 * (slightly wider than `approvalWindowDays` so we can show
 * "lastApprovalAt" for events that fell outside the catalyst window
 * but are still notable).
 */
export async function getRecentApprovalsForSymbol(
  symbol: string
): Promise<{ date: string; description: string }[]> {
  const cutoff = new Date(
    Date.now() - FDA_CONFIG.lookbackDays * 86_400_000
  );
  const rows = await db.fdaEvent.findMany({
    where: { symbol, eventType: "approval", date: { gte: cutoff } },
    orderBy: { date: "desc" },
  });
  return rows.map((r) => ({
    date: r.date.toISOString(),
    description: r.description,
  }));
}
