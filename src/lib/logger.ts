// Structured logger — single source of truth for all log output in src/.
//
// Usage:
//   import { log } from "@/lib/logger";
//   log.info("fetcher", "refresh.start", { count: 500 });
//   log.error("market-data", "yahoo.failure", { symbol, error: err });
//
// Rationale: a long-lived app needs structured, greppable logs. Direct
// `console.*` is forbidden in src/ — see CLAUDE.md "Code Quality Rule".
//
// Test friendliness: silenced by default under Vitest. Tests that need to
// assert log output can call `setLoggerSink()` to capture entries.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  component: string;
  event: string;
  meta?: Record<string, unknown>;
  timestamp: string;
}

export type LoggerSink = (entry: LogEntry) => void;

export const consoleSink: LoggerSink = (entry) => {
  const prefix = `[${entry.component}] ${entry.event}`;
  const payload = entry.meta ? [prefix, entry.meta] : [prefix];
  switch (entry.level) {
    case "debug":
      // eslint-disable-next-line no-console
      console.debug(...payload);
      break;
    case "info":
      // eslint-disable-next-line no-console
      console.log(...payload);
      break;
    case "warn":
      // eslint-disable-next-line no-console
      console.warn(...payload);
      break;
    case "error":
      // eslint-disable-next-line no-console
      console.error(...payload);
      break;
  }
};

export const silentSink: LoggerSink = () => {
  /* no-op — used in tests by default */
};

function defaultSink(): LoggerSink {
  // Vitest sets VITEST=true; Next.js sets NODE_ENV. Be defensive.
  const isTest =
    typeof process !== "undefined" &&
    (process.env?.VITEST === "true" || process.env?.NODE_ENV === "test");
  return isTest ? silentSink : consoleSink;
}

let activeSink: LoggerSink = defaultSink();

export function setLoggerSink(sink: LoggerSink): void {
  activeSink = sink;
}

export function resetLoggerSink(): void {
  activeSink = defaultSink();
}

function emit(
  level: LogLevel,
  component: string,
  event: string,
  meta?: Record<string, unknown>
): void {
  activeSink({
    level,
    component,
    event,
    meta,
    timestamp: new Date().toISOString(),
  });
}

export const log = {
  debug: (component: string, event: string, meta?: Record<string, unknown>) =>
    emit("debug", component, event, meta),
  info: (component: string, event: string, meta?: Record<string, unknown>) =>
    emit("info", component, event, meta),
  warn: (component: string, event: string, meta?: Record<string, unknown>) =>
    emit("warn", component, event, meta),
  error: (component: string, event: string, meta?: Record<string, unknown>) =>
    emit("error", component, event, meta),
};
