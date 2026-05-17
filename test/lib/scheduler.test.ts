import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

// `vi.hoisted` runs before any imports, so the mocked module's factory
// can safely reference the mock object. Without this, static `import`
// of `@/lib/scheduler` (which imports logger) blows up because
// `vi.mock` is hoisted above non-hoisted top-level vars.
const { loggerMock } = vi.hoisted(() => {
  return {
    loggerMock: {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    },
  };
});
vi.mock("@/lib/logger", () => loggerMock);

import {
  _resetForTests,
  getStatuses,
  isCronRunning,
  registerCron,
  startAll,
  stopAll,
} from "@/lib/scheduler";

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTests();
  loggerMock.log.info = vi.fn();
  loggerMock.log.warn = vi.fn();
  loggerMock.log.error = vi.fn();
});

afterEach(() => {
  _resetForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("scheduler.registerCron", () => {
  it("adds a task to the registry without arming it before startAll", () => {
    const run = vi.fn().mockResolvedValue(undefined);
    registerCron({ name: "task.a", intervalMs: 1000, run });

    expect(run).not.toHaveBeenCalled();
    const statuses = getStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      name: "task.a",
      intervalMs: 1000,
      isArmed: false,
      isRunning: false,
      lastStartedAt: null,
      lastCompletedAt: null,
    });
  });

  it("overwrites a prior registration with the same name (idempotent)", () => {
    registerCron({ name: "task.a", intervalMs: 1000, run: vi.fn() });
    registerCron({ name: "task.a", intervalMs: 2000, run: vi.fn() });
    expect(getStatuses()).toHaveLength(1);
    expect(getStatuses()[0].intervalMs).toBe(2000);
  });

  it("if registered AFTER startAll, the new task arms immediately", async () => {
    startAll();
    const run = vi.fn().mockResolvedValue(undefined);
    registerCron({ name: "late.task", intervalMs: 1000, run });
    // runOnStart defaults to true → the initial run fires synchronously
    // inside registerCron → run() is called before await returns.
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("scheduler.startAll", () => {
  it("runs each task immediately when runOnStart is true (default)", async () => {
    const runA = vi.fn().mockResolvedValue(undefined);
    const runB = vi.fn().mockResolvedValue(undefined);
    registerCron({ name: "a", intervalMs: 1000, run: runA });
    registerCron({ name: "b", intervalMs: 5000, run: runB });

    startAll();
    // The immediate runs are called synchronously by armEntry; the
    // returned promises just need a microtask flush to settle.
    await Promise.resolve();

    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);
  });

  it("waits one interval before first run when runOnStart=false", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    registerCron({
      name: "delayed",
      intervalMs: 1000,
      runOnStart: false,
      run,
    });

    startAll();
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fires each task again at its interval", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    registerCron({ name: "ticker", intervalMs: 1000, run });

    startAll();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("is a no-op when called twice (no double-arming)", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    registerCron({ name: "once", intervalMs: 1000, run });

    startAll();
    startAll(); // second call is a no-op
    await Promise.resolve();

    expect(run).toHaveBeenCalledTimes(1);
    expect(loggerMock.log.info).toHaveBeenCalledWith(
      "scheduler",
      "start.skip",
      expect.objectContaining({ reason: "already-armed" })
    );
  });
});

describe("scheduler.stopAll", () => {
  it("clears all intervals so no further ticks fire", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    registerCron({ name: "stoppable", intervalMs: 1000, run });

    startAll();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);

    stopAll();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1); // unchanged
  });

  it("is safe to call repeatedly", () => {
    registerCron({ name: "x", intervalMs: 1000, run: vi.fn() });
    startAll();
    stopAll();
    expect(() => stopAll()).not.toThrow();
  });

  it("preserves last-run status after stop (for /logs read-back)", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    registerCron({ name: "watcher", intervalMs: 1000, run });
    startAll();
    await Promise.resolve();
    stopAll();

    const status = getStatuses().find((s) => s.name === "watcher")!;
    expect(status.lastStartedAt).toBeInstanceOf(Date);
    expect(status.lastCompletedAt).toBeInstanceOf(Date);
    expect(status.isArmed).toBe(false);
  });
});

describe("scheduler error handling", () => {
  it("catches thrown errors and continues firing", async () => {
    let calls = 0;
    const run = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
    });
    registerCron({ name: "flaky", intervalMs: 1000, run });

    startAll();
    await Promise.resolve();
    await Promise.resolve();
    expect(loggerMock.log.error).toHaveBeenCalledWith(
      "flaky",
      "run.unhandled",
      expect.any(Object)
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2); // didn't get stuck after error
  });

  it("records lastError on the status (cleared on next successful run)", async () => {
    let attempts = 0;
    const run = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts === 1) throw new Error("first-fail");
    });
    registerCron({ name: "self-heal", intervalMs: 1000, run });

    startAll();
    await Promise.resolve();
    await Promise.resolve();
    expect(getStatuses()[0].lastError).toBe("first-fail");

    await vi.advanceTimersByTimeAsync(1000);
    expect(getStatuses()[0].lastError).toBeNull();
  });

  it("converts non-Error throws to a string", async () => {
    const run = vi.fn().mockImplementation(async () => {
      throw "plain string";
    });
    registerCron({ name: "weird", intervalMs: 1000, run });
    startAll();
    await Promise.resolve();
    await Promise.resolve();
    expect(getStatuses()[0].lastError).toBe("plain string");
  });
});

describe("scheduler overlap protection", () => {
  it("skips a tick when the previous run is still in flight", async () => {
    let resolveFirst!: () => void;
    const run = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        })
    );
    registerCron({ name: "slow", intervalMs: 1000, run });

    startAll();
    await vi.advanceTimersByTimeAsync(0); // let the initial run start
    expect(run).toHaveBeenCalledTimes(1);
    expect(isCronRunning("slow")).toBe(true);

    // Interval ticks again while the first run is still pending →
    // should be skipped, not double-invoke `run`.
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);

    resolveFirst();
    await vi.advanceTimersByTimeAsync(0);
    expect(isCronRunning("slow")).toBe(false);

    // After the first run resolves, the next tick fires normally.
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("getStatuses + isCronRunning", () => {
  it("returns isRunning=false for unknown names", () => {
    expect(isCronRunning("ghost")).toBe(false);
  });

  it("snapshots every registered task in registration order", () => {
    registerCron({ name: "first", intervalMs: 1, run: vi.fn() });
    registerCron({ name: "second", intervalMs: 2, run: vi.fn() });
    registerCron({ name: "third", intervalMs: 3, run: vi.fn() });
    expect(getStatuses().map((s) => s.name)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });
});
