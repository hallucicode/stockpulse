import { describe, it, expect } from "vitest";
import {
  validateBar,
  validateHistory,
  shouldQuarantine,
  maxSeverity,
  type DataQualityIssue,
} from "@/lib/data-quality";
import type { HistoricalBar } from "@/types";

function bar(overrides: Partial<HistoricalBar> = {}): HistoricalBar {
  return {
    date: "2026-04-20",
    open: 100,
    high: 102,
    low: 98,
    close: 101,
    volume: 1_000_000,
    ...overrides,
  };
}

function makeHistory(
  count: number,
  endDate = "2026-04-25",
  perBar?: (i: number) => Partial<HistoricalBar>
): HistoricalBar[] {
  const end = new Date(endDate).getTime();
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(end - (count - 1 - i) * 86_400_000);
    return bar({
      date: d.toISOString().split("T")[0],
      ...perBar?.(i),
    });
  });
}

const NOW = new Date("2026-04-26T12:00:00Z");

describe("validateBar", () => {
  it("accepts a clean bar", () => {
    expect(validateBar(bar())).toEqual([]);
  });

  it("rejects high < low as critical", () => {
    const issues = validateBar(bar({ high: 90, low: 100, close: 95 }));
    expect(issues.some((i) => i.severity === "critical")).toBe(true);
    expect(issues[0].type).toBe("invalid_bar");
  });

  it("rejects close outside [low, high]", () => {
    const issues = validateBar(bar({ low: 95, high: 100, close: 110 }));
    expect(issues.some((i) => i.detail.includes("outside"))).toBe(true);
  });

  it("rejects negative price", () => {
    const issues = validateBar(bar({ low: -1, close: -1 }));
    expect(issues.some((i) => i.detail.includes("Negative price"))).toBe(true);
  });

  it("rejects negative volume", () => {
    const issues = validateBar(bar({ volume: -10 }));
    expect(issues.some((i) => i.detail.includes("Negative volume"))).toBe(true);
  });

  it("rejects NaN/Infinity and short-circuits further checks", () => {
    const issues = validateBar(bar({ close: NaN }));
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).toContain("non-finite");
  });

  it("propagates index when given", () => {
    const issues = validateBar(bar({ high: 0, low: 5, close: 0 }), 7);
    expect(issues[0].index).toBe(7);
  });
});

describe("validateHistory", () => {
  it("returns empty_history for []", () => {
    const issues = validateHistory([], NOW);
    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe("empty_history");
    expect(issues[0].severity).toBe("high");
  });

  it("flags short history", () => {
    const issues = validateHistory(makeHistory(3), NOW);
    expect(issues.some((i) => i.type === "short_history")).toBe(true);
  });

  it("passes a clean recent history", () => {
    const hist = makeHistory(20, "2026-04-25");
    const issues = validateHistory(hist, NOW);
    expect(issues).toHaveLength(0);
  });

  it("flags stale data when last bar is too old", () => {
    const hist = makeHistory(20, "2026-04-01"); // 25 days before NOW
    const issues = validateHistory(hist, NOW);
    expect(issues.some((i) => i.type === "stale_data")).toBe(true);
    expect(
      issues.find((i) => i.type === "stale_data")?.severity
    ).toBe("high");
  });

  it("detects halt run of 3+ zero-volume bars", () => {
    const hist = makeHistory(20, "2026-04-25", (i) =>
      i >= 17 ? { volume: 0 } : {}
    );
    const issues = validateHistory(hist, NOW);
    const halt = issues.find((i) => i.type === "halt_run");
    expect(halt).toBeDefined();
    expect(halt?.severity).toBe("high");
  });

  it("does not flag a single zero-volume day as halt", () => {
    const hist = makeHistory(20, "2026-04-25", (i) =>
      i === 18 ? { volume: 0 } : {}
    );
    const issues = validateHistory(hist, NOW);
    expect(issues.some((i) => i.type === "halt_run")).toBe(false);
  });

  it("flags huge gap moves as medium", () => {
    const hist = makeHistory(20, "2026-04-25", (i) =>
      i < 18 ? { close: 100 } : { close: 50 } // 50% drop on i=18
    );
    const issues = validateHistory(hist, NOW);
    const gap = issues.find((i) => i.type === "huge_gap");
    expect(gap).toBeDefined();
    expect(gap?.severity).toBe("medium");
  });

  it("ignores gap when previous close is zero", () => {
    const hist = makeHistory(20, "2026-04-25", (i) =>
      i === 18 ? { close: 0 } : {}
    );
    // No huge_gap from 100→0 because prev=0 path returns 0%, but the
    // 0→100 jump on i=19 IS valid — close from 0 is undefined and
    // skipped. We just verify the function doesn't throw.
    expect(() => validateHistory(hist, NOW)).not.toThrow();
  });

  it("aggregates multiple issues", () => {
    const hist: HistoricalBar[] = [
      bar({ date: "2026-03-01", high: 1, low: 5, close: 3, volume: 0 }), // critical + halt
      bar({ date: "2026-03-02", volume: 0 }),
      bar({ date: "2026-03-03", volume: 0 }),
    ];
    const issues = validateHistory(hist, NOW);
    expect(issues.length).toBeGreaterThan(1);
    expect(issues.some((i) => i.type === "invalid_bar")).toBe(true);
    expect(issues.some((i) => i.type === "stale_data")).toBe(true);
  });

  it("uses provided `now` deterministically", () => {
    const hist = makeHistory(10, "2026-04-20");
    // 2026-04-22 — only 2 days after last bar → fresh
    expect(
      validateHistory(hist, new Date("2026-04-22T12:00:00Z")).some(
        (i) => i.type === "stale_data"
      )
    ).toBe(false);
    // 2026-05-15 — 25 days after last bar → stale
    expect(
      validateHistory(hist, new Date("2026-05-15T12:00:00Z")).some(
        (i) => i.type === "stale_data"
      )
    ).toBe(true);
  });

  it("ignores invalid last-bar date for staleness", () => {
    const hist = makeHistory(10, "2026-04-25");
    hist[hist.length - 1].date = "not-a-date";
    expect(() => validateHistory(hist, NOW)).not.toThrow();
  });
});

describe("shouldQuarantine", () => {
  it("quarantines on critical", () => {
    expect(
      shouldQuarantine([
        { type: "invalid_bar", severity: "critical", detail: "x" },
      ])
    ).toBe(true);
  });

  it("quarantines on high", () => {
    expect(
      shouldQuarantine([
        { type: "stale_data", severity: "high", detail: "x" },
      ])
    ).toBe(true);
  });

  it("does NOT quarantine on medium-only", () => {
    expect(
      shouldQuarantine([
        { type: "huge_gap", severity: "medium", detail: "x" },
      ])
    ).toBe(false);
  });

  it("does NOT quarantine on low-only", () => {
    expect(
      shouldQuarantine([
        { type: "huge_gap", severity: "low", detail: "x" },
      ])
    ).toBe(false);
  });

  it("returns false for empty", () => {
    expect(shouldQuarantine([])).toBe(false);
  });
});

describe("maxSeverity", () => {
  it("returns 'low' for empty list", () => {
    expect(maxSeverity([])).toBe("low");
  });

  it("returns the highest severity present", () => {
    const issues: DataQualityIssue[] = [
      { type: "huge_gap", severity: "medium", detail: "" },
      { type: "halt_run", severity: "high", detail: "" },
      { type: "huge_gap", severity: "low", detail: "" },
    ];
    expect(maxSeverity(issues)).toBe("high");
  });

  it("ranks critical > high > medium > low", () => {
    expect(
      maxSeverity([
        { type: "invalid_bar", severity: "critical", detail: "" },
        { type: "stale_data", severity: "high", detail: "" },
      ])
    ).toBe("critical");
  });
});
