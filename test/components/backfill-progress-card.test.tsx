import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  BackfillProgressCard,
  formatEta,
  type BackfillProgress,
} from "@/components/backfill-progress-card";

function makeProgress(overrides: Partial<BackfillProgress> = {}): BackfillProgress {
  return {
    startedAt: 1_000_000,
    currentSymbol: "AAPL",
    processed: 50,
    total: 980,
    succeeded: 45,
    empty: 3,
    errored: 2,
    totalBarsWritten: 56_700,
    ...overrides,
  };
}

describe("formatEta", () => {
  it("returns '—' for non-finite or negative values", () => {
    expect(formatEta(NaN)).toBe("—");
    expect(formatEta(Infinity)).toBe("—");
    expect(formatEta(-10)).toBe("—");
  });

  it("formats sub-minute values as seconds", () => {
    expect(formatEta(45_000)).toBe("45s");
  });

  it("formats ≥ 60s as minutes", () => {
    expect(formatEta(60_000)).toBe("1 min");
    expect(formatEta(540_000)).toBe("9 min");
  });
});

describe("BackfillProgressCard", () => {
  it("renders the progress bar, ETA, counters, and current symbol", () => {
    // Elapsed = now - startedAt = 60s. processed=50 / total=980 →
    // ETA = (60/50) × 930 = 1116s ≈ 19 min.
    render(
      <BackfillProgressCard
        progress={makeProgress()}
        now={1_060_000}
      />
    );
    expect(screen.getByText(/Backfilling watchlist/)).toBeInTheDocument();
    expect(screen.getByText(/50 \/ 980/)).toBeInTheDocument();
    expect(screen.getByText(/ETA 19 min/)).toBeInTheDocument();
    expect(screen.getByText(/AAPL/)).toBeInTheDocument();
    expect(screen.getByText(/✓ 45/)).toBeInTheDocument();
    expect(screen.getByText(/— 3/)).toBeInTheDocument();
    expect(screen.getByText(/✗ 2/)).toBeInTheDocument();
    expect(screen.getByText(/56,700 bars/)).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(bar).toHaveAttribute("aria-valuemax", "980");
  });

  it("shows 'starting…' when no symbol has been processed yet", () => {
    render(
      <BackfillProgressCard
        progress={makeProgress({
          currentSymbol: null,
          processed: 0,
          succeeded: 0,
          empty: 0,
          errored: 0,
          totalBarsWritten: 0,
        })}
        now={1_001_000}
      />
    );
    expect(screen.getByText(/starting…/)).toBeInTheDocument();
    // ETA is "—" because processed = 0 (divide-by-zero guard).
    expect(screen.getByText(/ETA —/)).toBeInTheDocument();
  });

  it("renders correctly when processed equals total (final tick)", () => {
    render(
      <BackfillProgressCard
        progress={makeProgress({ processed: 980, total: 980 })}
        now={1_060_000}
      />
    );
    expect(screen.getByText(/980 \/ 980/)).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar.firstChild).toHaveProperty("style");
  });
});
