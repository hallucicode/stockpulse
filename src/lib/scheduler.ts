// Phase 10 — cron scheduler (edge module).
//
// One registry for every recurring task in the system. Before this
// existed, background-fetcher.ts had 11 ad-hoc `setInterval` calls
// with 11 `let xxxId = null` variables and 11 cleanup blocks in
// `stopBackgroundFetcher`. Adding a 12th cron required touching all
// three locations. Now: each task registers once with a unique name,
// `startAll()` arms every interval, `stopAll()` clears them, and
// `getStatuses()` returns last-run timing for observability.
//
// Each task's `run` function is wrapped in a try/catch so unhandled
// rejections don't crash the host process — the prior pattern of
// `safeXxx()` wrappers per cron is folded into the scheduler itself.

import { log } from "./logger";

export interface CronTask {
  /** Stable id; also used as the log component for failures. */
  name: string;
  intervalMs: number;
  /** Run immediately on `startAll`, then on each interval. Default true
   *  — matches the prior background-fetcher behaviour where every cron
   *  fired once at boot before the setInterval armed. Pass false for
   *  tasks that should wait one interval before the first run. */
  runOnStart?: boolean;
  /** Async function the scheduler calls each tick. Errors are caught
   *  and logged as `<name>:run.unhandled`; the next tick still fires. */
  run: () => Promise<unknown>;
}

export interface CronStatus {
  name: string;
  intervalMs: number;
  runOnStart: boolean;
  lastStartedAt: Date | null;
  lastCompletedAt: Date | null;
  lastError: string | null;
  /** True from the moment `run` is called until it resolves/rejects. */
  isRunning: boolean;
  /** True once `startAll` has armed the setInterval for this task. */
  isArmed: boolean;
}

interface RegistryEntry {
  task: CronTask;
  intervalId: ReturnType<typeof setInterval> | null;
  lastStartedAt: Date | null;
  lastCompletedAt: Date | null;
  lastError: string | null;
  isRunning: boolean;
}

const registry = new Map<string, RegistryEntry>();
let armed = false;

/**
 * Register a cron with the scheduler. Idempotent on `name`: a second
 * registration with the same name overwrites the first (useful for
 * hot-reload during dev). Does NOT arm the interval — call `startAll`
 * for that, so the caller can register everything atomically before
 * any tick fires.
 *
 * If called AFTER `startAll`, the new task's interval is armed
 * immediately (and its `runOnStart` flag is respected).
 */
export function registerCron(task: CronTask): void {
  const existing = registry.get(task.name);
  if (existing?.intervalId) {
    clearInterval(existing.intervalId);
  }
  registry.set(task.name, {
    task,
    intervalId: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
    isRunning: false,
  });
  if (armed) {
    armEntry(task.name);
  }
}

/**
 * Arm every registered cron. Idempotent — if called twice, no-op the
 * second time (we don't want two intervals firing the same task).
 */
export function startAll(): void {
  if (armed) {
    log.info("scheduler", "start.skip", { reason: "already-armed" });
    return;
  }
  armed = true;
  for (const name of registry.keys()) {
    armEntry(name);
  }
  log.info("scheduler", "start", { count: registry.size });
}

/**
 * Clear every interval and reset armed state. Safe to call repeatedly.
 * Per-task status (lastStartedAt etc.) is preserved so `getStatuses`
 * still returns useful info post-stop.
 */
export function stopAll(): void {
  for (const entry of registry.values()) {
    if (entry.intervalId) {
      clearInterval(entry.intervalId);
      entry.intervalId = null;
    }
  }
  armed = false;
  log.info("scheduler", "stop", { count: registry.size });
}

/**
 * Snapshot of every registered cron's last-run state. Read by the
 * existing `/logs` health-card logic and the fetcher's `getFetcherStatus`.
 */
export function getStatuses(): CronStatus[] {
  return Array.from(registry.values()).map((entry) => ({
    name: entry.task.name,
    intervalMs: entry.task.intervalMs,
    runOnStart: entry.task.runOnStart ?? true,
    lastStartedAt: entry.lastStartedAt,
    lastCompletedAt: entry.lastCompletedAt,
    lastError: entry.lastError,
    isRunning: entry.isRunning,
    isArmed: entry.intervalId !== null,
  }));
}

/** True iff a cron with this name is currently mid-run. */
export function isCronRunning(name: string): boolean {
  return registry.get(name)?.isRunning ?? false;
}

/**
 * Test-only helper. Clears the registry AND the armed flag so test
 * files can start from a clean slate without `vi.resetModules`.
 */
export function _resetForTests(): void {
  for (const entry of registry.values()) {
    if (entry.intervalId) clearInterval(entry.intervalId);
  }
  registry.clear();
  armed = false;
}

function armEntry(name: string): void {
  const entry = registry.get(name);
  if (!entry) return;
  if (entry.intervalId) return; // already armed
  if (entry.task.runOnStart ?? true) {
    void runEntry(name);
  }
  entry.intervalId = setInterval(() => {
    void runEntry(name);
  }, entry.task.intervalMs);
}

async function runEntry(name: string): Promise<void> {
  const entry = registry.get(name);
  if (!entry) return;
  if (entry.isRunning) {
    // Skip overlapping runs. A long-running task whose interval ticks
    // again before it finishes shouldn't double-execute.
    return;
  }
  entry.isRunning = true;
  entry.lastStartedAt = new Date();
  entry.lastError = null;
  try {
    await entry.task.run();
    entry.lastCompletedAt = new Date();
  } catch (err) {
    entry.lastError = err instanceof Error ? err.message : String(err);
    log.error(entry.task.name, "run.unhandled", { error: err });
  } finally {
    entry.isRunning = false;
  }
}
