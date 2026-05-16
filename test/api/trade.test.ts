import { describe, it, expect, vi, beforeEach } from "vitest";

const actionsMock: any = {
  buyStock: vi.fn(),
  sellStock: vi.fn(),
  removePosition: vi.fn(),
};
vi.mock("@/lib/actions", () => actionsMock);

beforeEach(() => {
  actionsMock.buyStock = vi.fn();
  actionsMock.sellStock = vi.fn();
  actionsMock.removePosition = vi.fn();
});

function makeReq(body: any): any {
  return { json: async () => body };
}

describe("POST /api/trade", () => {
  it("buy with full args", async () => {
    actionsMock.buyStock.mockResolvedValue({ id: "p1" });
    const { POST } = await import("@/app/api/trade/route");
    const r = await POST(makeReq({ action: "buy", symbol: "A", shares: 1, price: 10 }));
    expect((await r.json()).id).toBe("p1");
  });

  it("buy missing symbol returns 400", async () => {
    const { POST } = await import("@/app/api/trade/route");
    const r = await POST(makeReq({ action: "buy" }));
    expect(r.status).toBe(400);
  });

  it("sell calls action", async () => {
    actionsMock.sellStock.mockResolvedValue({});
    const { POST } = await import("@/app/api/trade/route");
    const r = await POST(makeReq({ action: "sell", positionId: "p1" }));
    expect((await r.json()).ok).toBe(true);
  });

  it("sell missing positionId returns 400", async () => {
    const { POST } = await import("@/app/api/trade/route");
    const r = await POST(makeReq({ action: "sell" }));
    expect(r.status).toBe(400);
  });

  it("remove calls action", async () => {
    actionsMock.removePosition.mockResolvedValue({});
    const { POST } = await import("@/app/api/trade/route");
    const r = await POST(makeReq({ action: "remove", positionId: "p1" }));
    expect((await r.json()).ok).toBe(true);
  });

  it("remove missing positionId returns 400", async () => {
    const { POST } = await import("@/app/api/trade/route");
    const r = await POST(makeReq({ action: "remove" }));
    expect(r.status).toBe(400);
  });

  it("unknown action returns 400", async () => {
    const { POST } = await import("@/app/api/trade/route");
    const r = await POST(makeReq({ action: "weird" }));
    expect(r.status).toBe(400);
  });

  it("returns 500 on thrown error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    actionsMock.buyStock.mockRejectedValue(new Error("boom"));
    const { POST } = await import("@/app/api/trade/route");
    const r = await POST(makeReq({ action: "buy", symbol: "A", shares: 1, price: 10 }));
    expect(r.status).toBe(500);
  });
});
