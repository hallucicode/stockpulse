import { NextRequest, NextResponse } from "next/server";
import { buyStock, sellStock, removePosition } from "@/lib/actions";
import { log } from "@/lib/logger";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, symbol, shares, price, positionId, notes } = body;

    switch (action) {
      case "buy":
        if (!symbol || !shares || !price) {
          return NextResponse.json({ error: "Missing symbol, shares, or price" }, { status: 400 });
        }
        const position = await buyStock(symbol, shares, price, notes);
        return NextResponse.json(position);

      case "sell":
        if (!positionId) {
          return NextResponse.json({ error: "Missing positionId" }, { status: 400 });
        }
        await sellStock(positionId);
        return NextResponse.json({ ok: true });

      case "remove":
        if (!positionId) {
          return NextResponse.json({ error: "Missing positionId" }, { status: 400 });
        }
        await removePosition(positionId);
        return NextResponse.json({ ok: true });

      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    log.error("api.trade", "request.error", { error: err });
    return NextResponse.json({ error: "Trade failed" }, { status: 500 });
  }
}
