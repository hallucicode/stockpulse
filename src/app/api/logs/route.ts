import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { log } from "@/lib/logger";
import {
  computeAllHealth,
  HEALTH_SPECS,
  type PersistedLog,
} from "@/lib/health";

export const dynamic = "force-dynamic";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
// How many recent error/warn rows to fetch per component for the
// "recentIssues" sample shown on the /logs page. We only display 5 of
// them, but the pure `computeComponentHealth` recomputes counts from
// whatever it's given, so capping at 100 keeps the count accurate for the
// "X errors / Y warns" badge without ever loading the entire table.
const HEALTH_ISSUES_LIMIT_PER_COMPONENT = 100;

interface SerialisedEntry {
  id: string;
  timestamp: string;
  level: string;
  component: string;
  event: string;
  meta: Record<string, unknown> | null;
}

function safeParseMeta(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

interface DbLogRow {
  timestamp: Date;
  level: string;
  component: string;
  event: string;
  meta: string | null;
}

function toPersistedLog(r: DbLogRow): PersistedLog {
  return {
    timestamp: r.timestamp,
    level: r.level as PersistedLog["level"],
    component: r.component,
    event: r.event,
    meta: safeParseMeta(r.meta),
  };
}

/**
 * Build the minimal set of log entries needed by `computeAllHealth`.
 *
 * Naïvely fetching every row in the last N days for health computation
 * was the bottleneck (~14s with 160k rows). Instead, we run 3 small,
 * index-backed queries per component in parallel:
 *   1. Most recent `success` event (uses (component, timestamp) index).
 *   2. Most recent `start` event (same index, if defined).
 *   3. Most recent error/warn entries in last 24h (capped).
 *
 * The resulting list is small (a few hundred rows) but contains
 * everything the pure `computeAllHealth` function needs to produce
 * identical output to the old "fetch everything" approach.
 */
async function fetchHealthEntries(now: Date): Promise<PersistedLog[]> {
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const perComponent = await Promise.all(
    HEALTH_SPECS.map(async (spec) => {
      const startEvents = spec.startEvents ?? [];
      const [lastSuccess, lastStart, recentIssues] = await Promise.all([
        db.logEntry.findFirst({
          where: {
            component: spec.component,
            level: "info",
            event: { in: [...spec.successEvents] },
          },
          orderBy: { timestamp: "desc" },
        }),
        startEvents.length > 0
          ? db.logEntry.findFirst({
              where: {
                component: spec.component,
                level: "info",
                event: { in: [...startEvents] },
              },
              orderBy: { timestamp: "desc" },
            })
          : Promise.resolve(null),
        db.logEntry.findMany({
          where: {
            component: spec.component,
            level: { in: ["error", "warn"] },
            timestamp: { gte: dayAgo },
          },
          orderBy: { timestamp: "desc" },
          take: HEALTH_ISSUES_LIMIT_PER_COMPONENT,
        }),
      ]);
      return { lastSuccess, lastStart, recentIssues };
    })
  );

  const entries: PersistedLog[] = [];
  for (const { lastSuccess, lastStart, recentIssues } of perComponent) {
    if (lastSuccess) entries.push(toPersistedLog(lastSuccess));
    if (lastStart) entries.push(toPersistedLog(lastStart));
    for (const r of recentIssues) entries.push(toPersistedLog(r));
  }
  return entries;
}

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const level = params.get("level");
    const component = params.get("component");
    const limitParam = Number(params.get("limit"));
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(Math.floor(limitParam), MAX_LIMIT)
        : DEFAULT_LIMIT;

    const where: Record<string, unknown> = {};
    if (level) where.level = level;
    if (component) where.component = component;

    // Run the user-table query, the health queries, AND the distinct-
    // component lookup in parallel — they hit different indexes and don't
    // depend on each other. `distinct` returns ONE row per component
    // (cheap; uses the (component, timestamp) index) so the filter
    // dropdown can list every component that's ever logged, not just the
    // ones in the user's current paginated view.
    const [rows, healthEntries, distinctComponents] = await Promise.all([
      db.logEntry.findMany({
        where,
        orderBy: { timestamp: "desc" },
        take: limit,
      }),
      fetchHealthEntries(new Date()),
      db.logEntry.findMany({
        distinct: ["component"],
        select: { component: true },
        orderBy: { component: "asc" },
      }),
    ]);

    const entries: SerialisedEntry[] = rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp.toISOString(),
      level: r.level,
      component: r.component,
      event: r.event,
      meta: safeParseMeta(r.meta),
    }));

    const health = computeAllHealth(healthEntries);
    const components = distinctComponents.map((r) => r.component);

    return NextResponse.json({
      entries,
      health,
      components,
      total: entries.length,
      filters: { level, component, limit },
    });
  } catch (err) {
    log.error("api.logs", "fetch.error", { error: err });
    return NextResponse.json(
      { error: "Failed to fetch logs" },
      { status: 500 }
    );
  }
}
