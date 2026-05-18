// Pure module — derives per-component health from a list of log entries.
//
// "Is the app doing what it's expected to do?" is answered by checking that
// each known background job has produced a recent successful event. This
// file owns the rules for "recent enough" per component, and the mapping
// from event names to "this is a healthy run" semantics.
//
// Pure: no DB, no clock except `now` injected by the caller. The /logs API
// route does the DB read; this module does the math.
//
// Single source of truth for refresh cadences: each spec pulls its
// `refreshIntervalMs` directly from the relevant *_CONFIG block. Change
// the config — the /logs UI updates with no extra wiring.

import {
  FETCHER_CONFIG,
  EARNINGS_CONFIG,
  NEWS_CONFIG,
  FUNDAMENTALS_CONFIG,
  INSIDERS_CONFIG,
  ANALYSTS_CONFIG,
  REGIME_CONFIG,
  SECTOR_ROTATION_CONFIG,
  OPTIONS_CONFIG,
  FDA_CONFIG,
} from "./config";

export type HealthStatus =
  | "ok"
  | "stale"
  | "failing"
  | "starting" // a refresh.start was logged but no refresh.done yet — first cycle in flight
  | "unknown";

/**
 * One row in the saved log table — exact shape mirrors the Prisma model
 * minus implementation noise. `meta` is a parsed object (the API route
 * decodes the JSON column).
 */
export interface PersistedLog {
  timestamp: Date;
  level: "debug" | "info" | "warn" | "error";
  component: string;
  event: string;
  meta?: Record<string, unknown> | null;
}

export interface ComponentHealth {
  /** Component identifier as it appears in logs. */
  component: string;
  /** Human-readable name for the UI. */
  label: string;
  /** What this component is responsible for. */
  description: string;
  /** Last successful run, if any has happened. */
  lastSuccessAt: Date | null;
  /** Seconds since the last success — null if never seen. */
  lastSuccessAgeSec: number | null;
  /** Threshold (sec): success older than this → "stale". */
  expectedFreshnessSec: number;
  /** Cron cadence (ms). Sourced from the relevant *_CONFIG block. */
  refreshIntervalMs: number;
  /** Errors in the last 24h. */
  recentErrors: number;
  /** Warnings in the last 24h. */
  recentWarnings: number;
  /** Sample of recent error/warn events for the UI. */
  recentIssues: PersistedLog[];
  status: HealthStatus;
}

interface ComponentSpec {
  component: string;
  label: string;
  description: string;
  successEvents: string[];
  /** Events that mean "a cycle has started but isn't finished yet". */
  startEvents?: string[];
  expectedFreshnessSec: number;
  /** Cron cadence in ms. Read directly from the source config block — if
   *  the config changes, this changes with it. */
  refreshIntervalMs: number;
}

// One source of truth for "what does healthy look like for X?". Adding a new
// background job? Add a row here and it shows up on /logs automatically.
export const HEALTH_SPECS: ReadonlyArray<ComponentSpec> = [
  {
    component: "fetcher",
    label: "Stock fetcher",
    description: "Refreshes price history + analysis for every watchlist stock.",
    successEvents: ["refresh.done"],
    startEvents: ["refresh.start", "start"],
    expectedFreshnessSec: 15 * 60, // 5-min cron, allow 15 min slack
    refreshIntervalMs: FETCHER_CONFIG.refreshIntervalMs,
  },
  {
    component: "earnings",
    label: "Earnings calendar",
    description: "Daily Finnhub pull of upcoming earnings dates.",
    successEvents: ["refresh.done", "refresh.empty", "refresh.skip.no-key"],
    startEvents: ["refresh.start"],
    expectedFreshnessSec: 30 * 60 * 60, // daily cron, allow ~30h
    refreshIntervalMs: EARNINGS_CONFIG.refreshIntervalMs,
  },
  {
    component: "news",
    label: "News feed",
    description:
      "Daily Finnhub pull of company news for diagnosis classification.",
    successEvents: ["refresh.done", "refresh.skip.no-key"],
    startEvents: ["refresh.start"],
    expectedFreshnessSec: 30 * 60 * 60, // daily cron, allow ~30h
    refreshIntervalMs: NEWS_CONFIG.refreshIntervalMs,
  },
  {
    component: "fundamentals",
    label: "Fundamentals",
    description:
      "Weekly Finnhub pull of company financial metrics (market cap, EPS, debt, growth).",
    successEvents: ["refresh.done", "refresh.skip.no-key"],
    startEvents: ["refresh.start"],
    // Weekly cron — give it 8 days of slack before flagging stale.
    expectedFreshnessSec: 8 * 24 * 60 * 60,
    refreshIntervalMs: FUNDAMENTALS_CONFIG.refreshIntervalMs,
  },
  {
    component: "insiders",
    label: "Insider transactions",
    description:
      "Daily Finnhub pull of Form-4 insider buys/sells; cluster detection nudges score.",
    successEvents: ["refresh.done", "refresh.skip.no-key"],
    startEvents: ["refresh.start"],
    expectedFreshnessSec: 30 * 60 * 60,
    refreshIntervalMs: INSIDERS_CONFIG.refreshIntervalMs,
  },
  {
    component: "analysts",
    label: "Analyst actions",
    description:
      "Daily Yahoo pull of analyst upgrades/downgrades; recent actions nudge score.",
    successEvents: ["refresh.done"],
    startEvents: ["refresh.start"],
    expectedFreshnessSec: 30 * 60 * 60,
    refreshIntervalMs: ANALYSTS_CONFIG.refreshIntervalMs,
  },
  {
    component: "regime",
    label: "Market regime",
    description:
      "Daily SPY/VIX classification (trending / ranging / crisis). Drives per-signal weight adjustment.",
    successEvents: ["refresh.done"],
    startEvents: ["refresh.start"],
    expectedFreshnessSec: 30 * 60 * 60,
    refreshIntervalMs: REGIME_CONFIG.refreshIntervalMs,
  },
  {
    component: "options",
    label: "Options market",
    description:
      "Daily Yahoo options chain pull: ATM IV, put/call ratio, unusual flow. Feeds the IV-rank score adjustment.",
    successEvents: ["refresh.done"],
    startEvents: ["refresh.start"],
    expectedFreshnessSec: 30 * 60 * 60,
    refreshIntervalMs: OPTIONS_CONFIG.refreshIntervalMs,
  },
  {
    component: "sector-rotation",
    label: "Sector rotation",
    description:
      "Daily SPDR-sector-ETF classification (turning up / trending / flat). 'turning_up' sectors fire a +1 catalyst.",
    successEvents: ["refresh.done"],
    startEvents: ["refresh.start"],
    expectedFreshnessSec: 30 * 60 * 60,
    refreshIntervalMs: SECTOR_ROTATION_CONFIG.refreshIntervalMs,
  },
  {
    component: "fda",
    label: "FDA approvals",
    description:
      "Daily openFDA pull of recent drug approvals, matched against Healthcare-sector watchlist tickers. Fires a +1 catalyst on a recent approval.",
    successEvents: ["refresh.done", "refresh.empty-watchlist"],
    startEvents: ["refresh.start"],
    expectedFreshnessSec: 30 * 60 * 60,
    refreshIntervalMs: FDA_CONFIG.refreshIntervalMs,
  },
  {
    component: "discovery",
    label: "Trending discovery",
    description: "Yahoo trending tickers added to the watchlist every 30 min.",
    // Discovery has no "success" event when no new tickers are found. Treat
    // any successful discovery cycle that *did* add something as the success
    // signal. Until then we'll show "unknown" — acceptable, since this
    // component is a nice-to-have.
    successEvents: ["watchlist.added"],
    expectedFreshnessSec: 24 * 60 * 60,
    refreshIntervalMs: FETCHER_CONFIG.discoveryIntervalMs,
  },
] as const;

const DAY_SEC = 24 * 60 * 60;

/**
 * Score a single component using the relevant subset of log entries.
 * `entries` may be the global feed; we filter internally.
 */
export function computeComponentHealth(
  spec: ComponentSpec,
  entries: PersistedLog[],
  now: Date
): ComponentHealth {
  const componentEntries = entries.filter((e) => e.component === spec.component);

  // Last success
  let lastSuccessAt: Date | null = null;
  for (const e of componentEntries) {
    if (e.level === "info" && spec.successEvents.includes(e.event)) {
      if (lastSuccessAt === null || e.timestamp > lastSuccessAt) {
        lastSuccessAt = e.timestamp;
      }
    }
  }

  // Errors / warnings in the last 24h
  const dayAgo = new Date(now.getTime() - DAY_SEC * 1000);
  const recent = componentEntries.filter((e) => e.timestamp >= dayAgo);
  const errors = recent.filter((e) => e.level === "error");
  const warnings = recent.filter((e) => e.level === "warn");
  const recentIssues = [...errors, ...warnings]
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, 5);

  const lastSuccessAgeSec =
    lastSuccessAt === null
      ? null
      : Math.max(0, Math.floor((now.getTime() - lastSuccessAt.getTime()) / 1000));

  // Has a cycle started recently and not finished?
  //   refresh.start observed AFTER the most recent (or any) refresh.done →
  //   the job is currently running. This is the common case the user sees on
  //   a fresh dev-server boot: `refresh.start` fires immediately, then there
  //   are 2–3 minutes of per-stock warnings, then `refresh.done` lands. We
  //   want the card to clearly show "starting" during that window rather
  //   than "unknown" / "never".
  let cycleInFlight = false;
  if (spec.startEvents && spec.startEvents.length > 0) {
    let lastStartAt: Date | null = null;
    for (const e of componentEntries) {
      if (e.level === "info" && spec.startEvents.includes(e.event)) {
        if (lastStartAt === null || e.timestamp > lastStartAt) {
          lastStartAt = e.timestamp;
        }
      }
    }
    if (
      lastStartAt &&
      (lastSuccessAt === null || lastStartAt > lastSuccessAt) &&
      // Reasonable upper bound: if a "start" was logged > 30 min ago and no
      // "done" has landed, treat it as failing/stale instead of "starting".
      now.getTime() - lastStartAt.getTime() < 30 * 60 * 1000
    ) {
      cycleInFlight = true;
    }
  }

  // Status rules:
  //   - errors in the last hour            → failing
  //   - fresh success exists in window     → ok (even if a new cycle has
  //                                          just kicked off — for fast
  //                                          crons like the fetcher there
  //                                          is always a brief overlap)
  //   - no fresh success, but cycle in
  //     flight (cold start OR recovering)  → starting
  //   - no success ever                    → unknown
  //   - success exists but past window     → stale
  let status: HealthStatus;
  const hasRecentErrors = errors.some(
    (e) => e.timestamp.getTime() > now.getTime() - 60 * 60 * 1000
  );
  const successInWindow =
    lastSuccessAgeSec !== null && lastSuccessAgeSec <= spec.expectedFreshnessSec;
  if (hasRecentErrors) {
    status = "failing";
  } else if (successInWindow) {
    status = "ok";
  } else if (cycleInFlight) {
    status = "starting";
  } else if (lastSuccessAgeSec === null) {
    status = "unknown";
  } else {
    status = "stale";
  }

  return {
    component: spec.component,
    label: spec.label,
    description: spec.description,
    lastSuccessAt,
    lastSuccessAgeSec,
    expectedFreshnessSec: spec.expectedFreshnessSec,
    refreshIntervalMs: spec.refreshIntervalMs,
    recentErrors: errors.length,
    recentWarnings: warnings.length,
    recentIssues,
    status,
  };
}

export function computeAllHealth(
  entries: PersistedLog[],
  now: Date = new Date()
): ComponentHealth[] {
  return HEALTH_SPECS.map((spec) => computeComponentHealth(spec, entries, now));
}

/**
 * Format an "x minutes ago" / "2 hours ago" string. UI-friendly helper —
 * lives here because it's pure and reused on the server and client.
 */
export function formatAge(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 60 * 60) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 24 * 60 * 60) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Human-readable cron cadence ("every 5 min", "every 24h", "every 7 days").
 * Used by the /logs UI; pure so it can be unit-tested without DOM.
 */
export function formatInterval(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return min === 1 ? "1 min" : `${min} min`;
  const hr = Math.round(min / 60);
  if (hr < 24) return hr === 1 ? "1h" : `${hr}h`;
  const day = Math.round(hr / 24);
  return day === 1 ? "1 day" : `${day} days`;
}
