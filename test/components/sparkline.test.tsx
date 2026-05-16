import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Sparkline } from "@/components/sparkline";

describe("Sparkline", () => {
  it("returns null with < 2 points", () => {
    const { container } = render(<Sparkline data={[1]} />);
    expect(container.firstChild).toBeNull();
  });

  it("returns null with no data", () => {
    const { container } = render(<Sparkline data={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders svg with polyline for >=2 points", () => {
    const { container } = render(<Sparkline data={[1, 2, 3]} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(container.querySelector("polyline")).toBeTruthy();
    expect(container.querySelector("path")).toBeTruthy();
  });

  it("renders without area when showArea is false", () => {
    const { container } = render(<Sparkline data={[1, 2]} showArea={false} />);
    expect(container.querySelector("path")).toBeNull();
  });

  it("handles flat data (range fallback to 1)", () => {
    const { container } = render(<Sparkline data={[5, 5, 5]} />);
    expect(container.querySelector("polyline")).toBeTruthy();
  });

  it("respects custom width/height/color", () => {
    const { container } = render(
      <Sparkline data={[1, 2]} width={100} height={20} color="#ff0000" />
    );
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("100");
    expect(svg?.getAttribute("height")).toBe("20");
  });
});
