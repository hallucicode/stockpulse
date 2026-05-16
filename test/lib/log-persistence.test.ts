import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const dbMock: any = { logEntry: { create: vi.fn(), deleteMany: vi.fn() } };
vi.mock("@/lib/db", () => ({ db: dbMock }));

beforeEach(() => {
  vi.resetModules();
  dbMock.logEntry.create = vi.fn().mockResolvedValue({});
  dbMock.logEntry.deleteMany = vi.fn().mockResolvedValue({ count: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shouldPersist", () => {
  it("persists every warn and error", async () => {
    const { shouldPersist } = await import("@/lib/log-persistence");
    expect(
      shouldPersist({
        level: "warn",
        component: "x",
        event: "y",
        timestamp: "",
      })
    ).toBe(true);
    expect(
      shouldPersist({
        level: "error",
        component: "x",
        event: "y",
        timestamp: "",
      })
    ).toBe(true);
  });

  it("never persists debug", async () => {
    const { shouldPersist } = await import("@/lib/log-persistence");
    expect(
      shouldPersist({
        level: "debug",
        component: "fetcher",
        event: "refresh.done",
        timestamp: "",
      })
    ).toBe(false);
  });

  it("persists whitelisted info events only", async () => {
    const { shouldPersist } = await import("@/lib/log-persistence");
    expect(
      shouldPersist({
        level: "info",
        component: "fetcher",
        event: "refresh.done",
        timestamp: "",
      })
    ).toBe(true);
    expect(
      shouldPersist({
        level: "info",
        component: "fetcher",
        event: "random.thing",
        timestamp: "",
      })
    ).toBe(false);
  });
});

describe("serialiseMeta", () => {
  it("returns null for undefined", async () => {
    const { serialiseMeta } = await import("@/lib/log-persistence");
    expect(serialiseMeta(undefined)).toBeNull();
  });

  it("preserves Error fields (message + stack)", async () => {
    const { serialiseMeta } = await import("@/lib/log-persistence");
    const err = new Error("oh no");
    const out = serialiseMeta({ error: err, symbol: "X" });
    expect(out).toContain("oh no");
    expect(out).toContain("symbol");
  });

  it("falls back to String() on circular references", async () => {
    const { serialiseMeta } = await import("@/lib/log-persistence");
    const a: any = {};
    a.self = a;
    const out = serialiseMeta({ a });
    expect(typeof out).toBe("string");
  });
});

describe("createPersistingSink", () => {
  it("writes warn/error to the DB", async () => {
    const { createPersistingSink } = await import("@/lib/log-persistence");
    const sink = createPersistingSink();
    sink({
      level: "error",
      component: "fetcher",
      event: "x",
      timestamp: new Date().toISOString(),
    });
    // Allow the fire-and-forget promise to resolve
    await new Promise((r) => setImmediate(r));
    expect(dbMock.logEntry.create).toHaveBeenCalledTimes(1);
  });

  it("does not write debug", async () => {
    const { createPersistingSink } = await import("@/lib/log-persistence");
    const sink = createPersistingSink();
    sink({
      level: "debug",
      component: "fetcher",
      event: "x",
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setImmediate(r));
    expect(dbMock.logEntry.create).not.toHaveBeenCalled();
  });

  it("swallows DB errors silently (no throw, no recurse)", async () => {
    dbMock.logEntry.create.mockRejectedValue(new Error("db down"));
    const { createPersistingSink } = await import("@/lib/log-persistence");
    const sink = createPersistingSink();
    expect(() =>
      sink({
        level: "error",
        component: "fetcher",
        event: "x",
        timestamp: new Date().toISOString(),
      })
    ).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});

describe("pruneOldLogs", () => {
  it("calls deleteMany with a cutoff `keepDays` ago", async () => {
    const { pruneOldLogs } = await import("@/lib/log-persistence");
    await pruneOldLogs(7);
    expect(dbMock.logEntry.deleteMany).toHaveBeenCalled();
    const arg = dbMock.logEntry.deleteMany.mock.calls[0][0];
    expect(arg.where.timestamp.lt).toBeInstanceOf(Date);
  });

  it("returns the count from the DB result", async () => {
    dbMock.logEntry.deleteMany.mockResolvedValue({ count: 42 });
    const { pruneOldLogs } = await import("@/lib/log-persistence");
    expect(await pruneOldLogs()).toBe(42);
  });
});
