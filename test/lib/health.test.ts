import { describe, it, expect } from "vitest";
import {
  computeAllHealth,
  computeComponentHealth,
  formatAge,
  formatInterval,
  HEALTH_SPECS,
  type PersistedLog,
} from "@/lib/health";

const NOW = new Date("2026-04-27T12:00:00Z");

function entry(
  component: string,
  event: string,
  level: PersistedLog["level"] = "info",
  ageSec = 0
): PersistedLog {
  return {
    component,
    event,
    level,
    timestamp: new Date(NOW.getTime() - ageSec * 1000),
  };
}

describe("computeComponentHealth", () => {
  const fetcherSpec = HEALTH_SPECS.find((s) => s.component === "fetcher")!;

  it("returns 'unknown' when no entries exist for the component", () => {
    const h = computeComponentHealth(fetcherSpec, [], NOW);
    expect(h.status).toBe("unknown");
    expect(h.lastSuccessAt).toBeNull();
    expect(h.lastSuccessAgeSec).toBeNull();
  });

  it("returns 'ok' on a fresh successful run", () => {
    const h = computeComponentHealth(
      fetcherSpec,
      [entry("fetcher", "refresh.done", "info", 60)],
      NOW
    );
    expect(h.status).toBe("ok");
    expect(h.lastSuccessAgeSec).toBe(60);
  });

  it("returns 'stale' when last success is older than freshness window", () => {
    const h = computeComponentHealth(
      fetcherSpec,
      [entry("fetcher", "refresh.done", "info", 60 * 60)], // 1h ago
      NOW
    );
    expect(h.status).toBe("stale");
  });

  it("returns 'failing' on a recent error even if there's a recent success", () => {
    const h = computeComponentHealth(
      fetcherSpec,
      [
        entry("fetcher", "refresh.done", "info", 60),
        entry("fetcher", "refresh.error", "error", 30),
      ],
      NOW
    );
    expect(h.status).toBe("failing");
  });

  it("counts errors and warnings in the last 24h only", () => {
    const h = computeComponentHealth(
      fetcherSpec,
      [
        entry("fetcher", "refresh.done", "info", 60),
        entry("fetcher", "x", "error", 60), // recent error
        entry("fetcher", "y", "warn", 60),
        entry("fetcher", "old", "error", 48 * 60 * 60), // 48h ago — ignored
      ],
      NOW
    );
    expect(h.recentErrors).toBe(1);
    expect(h.recentWarnings).toBe(1);
    expect(h.recentIssues).toHaveLength(2);
  });

  it("filters out other components' entries", () => {
    const h = computeComponentHealth(
      fetcherSpec,
      [
        entry("earnings", "refresh.done", "info", 60),
        entry("earnings", "fetch.error", "error", 60),
      ],
      NOW
    );
    expect(h.lastSuccessAt).toBeNull();
    expect(h.recentErrors).toBe(0);
  });

  it("picks the most recent success when multiple exist", () => {
    const h = computeComponentHealth(
      fetcherSpec,
      [
        entry("fetcher", "refresh.done", "info", 600),
        entry("fetcher", "refresh.done", "info", 60),
        entry("fetcher", "refresh.done", "info", 6000),
      ],
      NOW
    );
    expect(h.lastSuccessAgeSec).toBe(60);
  });

  it("treats older-than-1h errors as not 'failing' (just a count)", () => {
    const h = computeComponentHealth(
      fetcherSpec,
      [
        entry("fetcher", "refresh.done", "info", 60),
        entry("fetcher", "x", "error", 2 * 60 * 60), // 2h ago
      ],
      NOW
    );
    expect(h.status).toBe("ok");
    expect(h.recentErrors).toBe(1);
  });

  it("returns 'starting' when refresh.start is the only event so far", () => {
    const h = computeComponentHealth(
      fetcherSpec,
      [
        entry("fetcher", "refresh.start", "info", 60),
        entry("fetcher", "yahoo.history.failure", "warn", 30),
      ],
      NOW
    );
    expect(h.status).toBe("starting");
  });

  it("returns 'starting' when previous success is older than freshness window and a new cycle is in flight", () => {
    // Long-running refresh (news/insiders/analysts ~14 min) currently in
    // flight after a stale prior success should show "starting", not "stale".
    const h = computeComponentHealth(
      fetcherSpec,
      [
        entry("fetcher", "refresh.done", "info", 24 * 60 * 60), // older than 15 min fresh window
        entry("fetcher", "refresh.start", "info", 60), // new cycle 1 min ago
      ],
      NOW
    );
    expect(h.status).toBe("starting");
  });

  it("returns 'ok' (not 'starting') when fresh success exists and a new cycle starts", () => {
    // Regression: for fast crons (e.g. fetcher every 5 min), there is
    // always a brief overlap where the next refresh.start is logged before
    // the previous refresh.done has aged out. That overlap is normal
    // operation — must NOT downgrade ok to starting.
    const h = computeComponentHealth(
      fetcherSpec,
      [
        entry("fetcher", "refresh.done", "info", 120), // 2 min ago — inside 15 min fresh window
        entry("fetcher", "refresh.start", "info", 60), // next cycle started 1 min ago
      ],
      NOW
    );
    expect(h.status).toBe("ok");
  });

  it("does not return 'starting' if a refresh.done has landed since", () => {
    const h = computeComponentHealth(
      fetcherSpec,
      [
        entry("fetcher", "refresh.start", "info", 600),
        entry("fetcher", "refresh.done", "info", 120),
      ],
      NOW
    );
    expect(h.status).toBe("ok");
  });

  it("does not return 'starting' if refresh.start is older than 30 min", () => {
    const h = computeComponentHealth(
      fetcherSpec,
      [entry("fetcher", "refresh.start", "info", 60 * 60)], // 1h ago, no done
      NOW
    );
    expect(h.status).toBe("unknown");
  });

  it("limits recentIssues to 5 most recent", () => {
    const issues: PersistedLog[] = [];
    for (let i = 0; i < 10; i++) {
      issues.push(entry("fetcher", `e${i}`, "error", i * 10));
    }
    const h = computeComponentHealth(fetcherSpec, issues, NOW);
    expect(h.recentIssues).toHaveLength(5);
  });
});

describe("computeAllHealth", () => {
  it("returns one entry per known spec, in spec order", () => {
    const result = computeAllHealth([], NOW);
    expect(result.map((r) => r.component)).toEqual(
      HEALTH_SPECS.map((s) => s.component)
    );
  });

  it("uses default `now` when not provided", () => {
    const result = computeAllHealth([]);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("HEALTH_SPECS source-of-truth", () => {
  it("each spec exposes a positive refreshIntervalMs sourced from config", () => {
    for (const spec of HEALTH_SPECS) {
      expect(spec.refreshIntervalMs).toBeGreaterThan(0);
    }
  });

  it("computeComponentHealth surfaces refreshIntervalMs on the output", () => {
    const fetcherSpec = HEALTH_SPECS.find((s) => s.component === "fetcher")!;
    const h = computeComponentHealth(fetcherSpec, [], NOW);
    expect(h.refreshIntervalMs).toBe(fetcherSpec.refreshIntervalMs);
  });
});

describe("formatInterval", () => {
  it("formats sub-second values as ms", () => {
    expect(formatInterval(500)).toBe("500ms");
  });
  it("formats seconds", () => {
    expect(formatInterval(45_000)).toBe("45s");
  });
  it("formats minutes (singular + plural)", () => {
    expect(formatInterval(60_000)).toBe("1 min");
    expect(formatInterval(5 * 60_000)).toBe("5 min");
  });
  it("formats hours", () => {
    expect(formatInterval(3600_000)).toBe("1h");
    expect(formatInterval(12 * 3600_000)).toBe("12h");
  });
  it("formats days (singular + plural)", () => {
    expect(formatInterval(24 * 3600_000)).toBe("1 day");
    expect(formatInterval(7 * 24 * 3600_000)).toBe("7 days");
  });
});

describe("formatAge", () => {
  it("returns 'never' for null", () => {
    expect(formatAge(null)).toBe("never");
  });

  it("formats seconds, minutes, hours, days", () => {
    expect(formatAge(30)).toBe("30s ago");
    expect(formatAge(120)).toBe("2m ago");
    expect(formatAge(3600 * 5)).toBe("5h ago");
    expect(formatAge(86400 * 3)).toBe("3d ago");
  });
});
