// Edge module: persist a curated subset of log entries to the DB so /logs
// can show "is the app doing what it's expected to do?" — see CLAUDE.md
// "Observability is not optional".
//
// Design notes:
//   - Pure-core/edge separation: this module does I/O (DB writes). The
//     decision logic for "should this entry be persisted?" lives here too,
//     because there's no shared state with anything else and pulling it into
//     a separate file would be over-engineering.
//   - Composes with `consoleSink`: every persisted entry is also printed,
//     so dev tail-the-output workflows still work.
//   - DB write is fire-and-forget. We never await it from the hot path —
//     the application logic must not be slowed down by audit-log writes.
//   - Recursion safety: the catch handler does NOT call back into `log.*`.
//     If DB writes are failing, we'd flood the table with error entries.
//     Silent swallow is the right choice; the broken DB itself is the
//     unmissable signal in any deployment.

import { consoleSink, type LogEntry, type LoggerSink } from "./logger";
import { db } from "./db";
import { LOG_PERSISTENCE_CONFIG } from "./config";

// Whitelisted info-level events. Each one represents a "milestone" we want
// to be able to see on /logs — last successful refresh, etc.
//
// Format: "<component>:<event>". Component is matched literally; event is
// matched literally (no glob).
const PERSISTED_INFO_EVENTS: ReadonlySet<string> = new Set([
  "fetcher:start",
  "fetcher:stop",
  "fetcher:refresh.start",
  "fetcher:refresh.done",
  "fetcher:refresh.skip",
  "fetcher:quarantine",
  "fetcher:refresh.progress",
  "earnings:refresh.start",
  "earnings:refresh.done",
  "earnings:refresh.empty",
  "earnings:refresh.skip.no-key",
  "news:refresh.start",
  "news:refresh.done",
  "news:refresh.progress",
  "news:refresh.skip.no-key",
  "fundamentals:refresh.start",
  "fundamentals:refresh.done",
  "fundamentals:refresh.progress",
  "fundamentals:refresh.skip.no-key",
  "insiders:refresh.start",
  "insiders:refresh.done",
  "insiders:refresh.progress",
  "insiders:refresh.skip.no-key",
  "analysts:refresh.start",
  "analysts:refresh.done",
  "analysts:refresh.progress",
  "regime:refresh.start",
  "regime:refresh.done",
  "sector-rotation:refresh.start",
  "sector-rotation:refresh.done",
  "options:refresh.start",
  "options:refresh.done",
  "options:refresh.progress",
  "fda:refresh.start",
  "fda:refresh.done",
  "fda:refresh.empty-watchlist",
  "fda:fetch.empty",
  "audit-log:prune.done",
  "discovery:watchlist.added",
  "notifications:skip.no-topic",
]);

export function shouldPersist(entry: LogEntry): boolean {
  if (entry.level === "warn" || entry.level === "error") return true;
  if (entry.level === "info") {
    return PERSISTED_INFO_EVENTS.has(`${entry.component}:${entry.event}`);
  }
  return false; // debug: never persisted
}

/**
 * Serialise the meta object for storage. Errors get special treatment so we
 * keep the message + stack instead of an empty `{}`. Returns null when there
 * is nothing useful to store.
 */
export function serialiseMeta(
  meta: Record<string, unknown> | undefined
): string | null {
  if (!meta) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v instanceof Error) {
      out[k] = { name: v.name, message: v.message, stack: v.stack };
    } else {
      out[k] = v;
    }
  }
  try {
    return JSON.stringify(out);
  } catch {
    // Circular reference or non-serialisable value — fall back to a string.
    return String(out);
  }
}

/**
 * Build a sink that writes to console and (when warranted) to the DB.
 * The DB write is fire-and-forget — failures are silently swallowed because
 * we cannot recurse into the logger to report them.
 */
export function createPersistingSink(): LoggerSink {
  return (entry) => {
    consoleSink(entry);
    if (!shouldPersist(entry)) return;
    // Fire-and-forget — never await, never throw upward.
    db.logEntry
      .create({
        data: {
          timestamp: new Date(entry.timestamp),
          level: entry.level,
          component: entry.component,
          event: entry.event,
          meta: serialiseMeta(entry.meta),
        },
      })
      .catch(() => {
        /* swallow — see "Recursion safety" in the file header */
      });
  };
}

/**
 * Periodic prune so the LogEntry table doesn't grow unbounded during outages.
 * Caller decides how often to invoke it (instrumentation.ts schedules a
 * daily cron). Keeps the last `keepDays` worth of entries.
 */
export async function pruneOldLogs(
  keepDays = LOG_PERSISTENCE_CONFIG.retentionDays
): Promise<number> {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000);
  const r = await db.logEntry.deleteMany({
    where: { timestamp: { lt: cutoff } },
  });
  return r.count;
}
