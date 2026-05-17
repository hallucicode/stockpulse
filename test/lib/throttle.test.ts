import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { serialThrottle, sleep } from "@/lib/throttle";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sleep", () => {
  it("resolves after exactly the requested ms (under fake timers)", async () => {
    let resolved = false;
    void sleep(100).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });
});

describe("serialThrottle", () => {
  it("iterates items in order and counts outcomes", async () => {
    const items = ["a", "b", "c"];
    const seen: string[] = [];
    const run = vi.fn().mockImplementation(async (item: string) => {
      seen.push(item);
      return { kind: "ok" } as const;
    });

    const promise = serialThrottle({ items, spacingMs: 0, run });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(seen).toEqual(["a", "b", "c"]);
    expect(result).toMatchObject({
      total: 3,
      succeeded: 3,
      skipped: 0,
      rateLimited: 0,
      errored: 0,
    });
  });

  it("applies spacingMs between items (but not after the last)", async () => {
    const startTimes: number[] = [];
    const run = vi.fn().mockImplementation(async () => {
      startTimes.push(Date.now());
      return { kind: "ok" } as const;
    });

    const t0 = Date.now();
    const promise = serialThrottle({
      items: [1, 2, 3],
      spacingMs: 100,
      run,
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(startTimes[0]).toBe(t0);
    expect(startTimes[1]).toBe(t0 + 100);
    expect(startTimes[2]).toBe(t0 + 200);
  });

  it("counts ok / skipped / rate_limited / error outcomes separately", async () => {
    const run = vi.fn().mockImplementation(async (item: string) => {
      if (item === "ok") return { kind: "ok" } as const;
      if (item === "skip") return { kind: "skipped" } as const;
      if (item === "rl") return { kind: "rate_limited" } as const;
      return { kind: "error" } as const;
    });

    const promise = serialThrottle({
      items: ["ok", "skip", "rl", "err", "ok"],
      spacingMs: 0,
      run,
    });
    await vi.runAllTimersAsync();
    const r = await promise;

    expect(r).toMatchObject({
      total: 5,
      succeeded: 2,
      skipped: 1,
      rateLimited: 1,
      errored: 1,
    });
  });

  it("catches thrown errors and treats them as `error` outcomes", async () => {
    let calls = 0;
    const run = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 2) throw new Error("boom");
      return { kind: "ok" } as const;
    });

    const promise = serialThrottle({
      items: [1, 2, 3],
      spacingMs: 0,
      run,
    });
    await vi.runAllTimersAsync();
    const r = await promise;

    expect(r.total).toBe(3);
    expect(r.errored).toBe(1);
    expect(r.succeeded).toBe(2);
  });

  it("backs off rateLimitBackoffMs after a rate_limited step", async () => {
    const startTimes: number[] = [];
    const run = vi.fn().mockImplementation(async () => {
      startTimes.push(Date.now());
      return startTimes.length === 1
        ? ({ kind: "rate_limited" } as const)
        : ({ kind: "ok" } as const);
    });

    const t0 = Date.now();
    const promise = serialThrottle({
      items: [1, 2],
      spacingMs: 10,
      rateLimitBackoffMs: 500,
      run,
    });
    await vi.runAllTimersAsync();
    await promise;

    // Item 1 at t0, then backoff 500ms, then spacing 10ms → item 2 at t0+510.
    expect(startTimes[0]).toBe(t0);
    expect(startTimes[1]).toBe(t0 + 510);
  });

  it("fires onProgress every N items (and never at the last item)", async () => {
    const onProgress = vi.fn();
    const items = Array.from({ length: 7 }, (_, i) => i);
    const run = async () => ({ kind: "ok" } as const);

    const promise = serialThrottle({
      items,
      spacingMs: 0,
      onProgress,
      progressEveryN: 3,
      run,
    });
    await vi.runAllTimersAsync();
    await promise;

    // Should fire at processed=3 and processed=6, but NOT at processed=7
    // (last item — `onProgress` is for during-the-loop reporting).
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls[0][0]).toMatchObject({
      processed: 3,
      total: 7,
    });
    expect(onProgress.mock.calls[1][0]).toMatchObject({
      processed: 6,
      total: 7,
    });
  });

  it("handles an empty items array gracefully", async () => {
    const r = await serialThrottle({
      items: [],
      spacingMs: 1000,
      run: vi.fn(),
    });
    expect(r).toMatchObject({
      total: 0,
      succeeded: 0,
      skipped: 0,
      rateLimited: 0,
      errored: 0,
    });
  });

  it("records non-zero durationMs", async () => {
    const promise = serialThrottle({
      items: [1, 2],
      spacingMs: 250,
      run: async () => ({ kind: "ok" } as const),
    });
    await vi.runAllTimersAsync();
    const r = await promise;
    expect(r.durationMs).toBeGreaterThanOrEqual(250);
  });
});
