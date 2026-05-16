import { describe, it, expect, vi, beforeEach } from "vitest";

const actionsMock: any = { getPortfolio: vi.fn() };
vi.mock("@/lib/actions", () => actionsMock);

beforeEach(() => {
  actionsMock.getPortfolio = vi.fn();
});

describe("GET /api/portfolio", () => {
  it("returns portfolio data", async () => {
    actionsMock.getPortfolio.mockResolvedValue([{ id: "p1" }]);
    const { GET } = await import("@/app/api/portfolio/route");
    const r = await GET();
    const j = await r.json();
    expect(j).toEqual([{ id: "p1" }]);
  });

  it("returns 500 on error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    actionsMock.getPortfolio.mockRejectedValue(new Error("fail"));
    const { GET } = await import("@/app/api/portfolio/route");
    const r = await GET();
    expect(r.status).toBe(500);
  });
});
