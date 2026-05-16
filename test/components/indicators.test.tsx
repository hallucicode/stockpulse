import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ScoreGauge, SignalBadge, RecommendationBadge } from "@/components/indicators";

describe("ScoreGauge", () => {
  it("renders positive score with + prefix", () => {
    const { getByText } = render(<ScoreGauge score={50} />);
    expect(getByText("+50")).toBeInTheDocument();
  });

  it("renders negative score without + prefix", () => {
    const { getByText } = render(<ScoreGauge score={-30} />);
    expect(getByText("-30")).toBeInTheDocument();
  });

  it("renders zero", () => {
    const { getByText } = render(<ScoreGauge score={0} />);
    expect(getByText("0")).toBeInTheDocument();
  });
});

describe("SignalBadge", () => {
  it("renders buy variant", () => {
    const { getByText } = render(<SignalBadge type="buy" label="Buy Signal" />);
    expect(getByText("Buy Signal").className).toContain("emerald");
  });
  it("renders sell variant", () => {
    const { getByText } = render(<SignalBadge type="sell" label="Sell" />);
    expect(getByText("Sell").className).toContain("rose");
  });
  it("renders neutral variant", () => {
    const { getByText } = render(<SignalBadge type="neutral" label="Neutral" />);
    expect(getByText("Neutral").className).toContain("slate");
  });
});

describe("RecommendationBadge", () => {
  const cases: Array<[number, string]> = [
    [50, "emerald-400"],
    [20, "emerald-300"],
    [0, "amber-400"],
    [-20, "orange-400"],
    [-50, "rose-400"],
  ];
  for (const [score, expected] of cases) {
    it(`uses ${expected} for score ${score}`, () => {
      const { getByText } = render(
        <RecommendationBadge recommendation="X" score={score} />
      );
      expect(getByText("X").className).toContain(expected);
    });
  }
});
