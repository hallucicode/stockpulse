// Phase 10 — shared throttle helpers.
//
// Before this module existed, five source files had identical copies of
// `function sleep(ms)` plus near-identical `for (...) { ... await sleep
// (spacing); }` loops with per-symbol progress logging and 429 backoff.
// Per CLAUDE.md "the third copy is a bug" — we were at the fifth.
//
// This module owns the one true serial-with-spacing loop. Callers
// provide a `run` per item that returns a typed `ThrottleStepResult`,
// and the loop handles spacing, progress reporting, 429 backoff, and
// per-item error isolation.

/** Sleep for `ms` milliseconds. Fake-timer aware (uses setTimeout). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Outcome of running a single item through the throttle. */
export type ThrottleStepResult =
  | { kind: "ok" }
  | { kind: "skipped" }
  | { kind: "rate_limited" }
  | { kind: "error" };

export interface SerialThrottleOptions<T> {
  items: T[];
  /** Spacing between items in ms. 0 = no delay (still serial). */
  spacingMs: number;
  /** Optional backoff after a `rate_limited` step before the next item. */
  rateLimitBackoffMs?: number;
  /** Optional progress callback fired every `progressEveryN` items. */
  onProgress?: (info: {
    processed: number;
    total: number;
    succeeded: number;
    skipped: number;
    rateLimited: number;
    errored: number;
  }) => void;
  /** How often `onProgress` fires. Default 50 (matches existing source modules). */
  progressEveryN?: number;
  /** Per-item function. Throwing aborts the loop; return `error` to keep going. */
  run: (item: T, index: number) => Promise<ThrottleStepResult>;
}

export interface SerialThrottleSummary {
  total: number;
  succeeded: number;
  skipped: number;
  rateLimited: number;
  errored: number;
  durationMs: number;
}

/**
 * Iterate `items` serially with `spacingMs` between each (and an extra
 * `rateLimitBackoffMs` after any item returns `rate_limited`). Errors
 * thrown by `run` are caught and counted; the loop continues. Returns a
 * summary of outcomes.
 */
export async function serialThrottle<T>(
  opts: SerialThrottleOptions<T>
): Promise<SerialThrottleSummary> {
  const start = Date.now();
  let succeeded = 0;
  let skipped = 0;
  let rateLimited = 0;
  let errored = 0;
  const progressEveryN = opts.progressEveryN ?? 50;

  for (let i = 0; i < opts.items.length; i++) {
    let result: ThrottleStepResult;
    try {
      result = await opts.run(opts.items[i], i);
    } catch {
      // Defensive: a throwing `run` shouldn't abort the whole loop.
      // Callers should normally return `error` themselves so they can
      // log specific context, but we don't trust that.
      result = { kind: "error" };
    }
    switch (result.kind) {
      case "ok":
        succeeded++;
        break;
      case "skipped":
        skipped++;
        break;
      case "rate_limited":
        rateLimited++;
        if (opts.rateLimitBackoffMs && opts.rateLimitBackoffMs > 0) {
          await sleep(opts.rateLimitBackoffMs);
        }
        break;
      case "error":
        errored++;
        break;
    }

    const processed = i + 1;
    if (
      opts.onProgress &&
      processed % progressEveryN === 0 &&
      processed < opts.items.length
    ) {
      opts.onProgress({
        processed,
        total: opts.items.length,
        succeeded,
        skipped,
        rateLimited,
        errored,
      });
    }

    // Spacing between items — skip on the last one (nothing follows).
    if (i < opts.items.length - 1 && opts.spacingMs > 0) {
      await sleep(opts.spacingMs);
    }
  }

  return {
    total: opts.items.length,
    succeeded,
    skipped,
    rateLimited,
    errored,
    durationMs: Date.now() - start,
  };
}
