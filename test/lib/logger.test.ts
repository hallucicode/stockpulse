import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { log, setLoggerSink, resetLoggerSink, type LogEntry } from "@/lib/logger";

describe("logger", () => {
  let captured: LogEntry[];

  beforeEach(() => {
    captured = [];
    setLoggerSink((entry) => captured.push(entry));
  });

  afterEach(() => {
    resetLoggerSink();
  });

  it("emits info entries with component, event, meta", () => {
    log.info("component", "event.name", { foo: "bar" });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      level: "info",
      component: "component",
      event: "event.name",
      meta: { foo: "bar" },
    });
    expect(captured[0].timestamp).toBeTypeOf("string");
  });

  it("supports debug, warn, error levels", () => {
    log.debug("c", "e1");
    log.warn("c", "e2");
    log.error("c", "e3", { code: 500 });
    expect(captured.map((e) => e.level)).toEqual(["debug", "warn", "error"]);
    expect(captured[2].meta).toEqual({ code: 500 });
  });

  it("works without meta", () => {
    log.info("c", "e");
    expect(captured[0].meta).toBeUndefined();
  });

  it("resetLoggerSink swaps back to default (silent in test env)", () => {
    resetLoggerSink();
    // Should not throw and not capture (default sink in test env is silent).
    expect(() => log.info("c", "e")).not.toThrow();
    expect(captured).toHaveLength(0);
  });

  it("custom sink receives all entries", () => {
    const sink = vi.fn();
    setLoggerSink(sink);
    log.info("c", "e1");
    log.error("c", "e2");
    expect(sink).toHaveBeenCalledTimes(2);
  });
});

// Separately exercise the default console-backed sink so its switch arms get
// covered. We re-import the module with VITEST flag cleared and stub console.
describe("logger consoleSink", () => {
  it("dispatches each level to the right console method", async () => {
    const originalVitest = process.env.VITEST;
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.VITEST = "false";
    process.env.NODE_ENV = "production";

    vi.resetModules();
    const fresh = await import("@/lib/logger");

    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    fresh.log.debug("c", "d", { a: 1 });
    fresh.log.info("c", "i");
    fresh.log.warn("c", "w");
    fresh.log.error("c", "e");

    expect(debugSpy).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();

    debugSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();

    process.env.VITEST = originalVitest;
    process.env.NODE_ENV = originalNodeEnv;
    vi.resetModules();
  });
});
