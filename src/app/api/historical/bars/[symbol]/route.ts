// Phase 15a — per-symbol historical bars endpoint.
//
// GET returns the full bar series for one symbol, date-ascending.
// Empty array when no bars have been backfilled yet.

import { NextRequest, NextResponse } from "next/server";
import { getSymbolBars } from "@/lib/historical-bars-source";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { symbol: string } }
) {
  const symbol = params.symbol?.toUpperCase();
  if (!symbol) {
    return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  }

  try {
    const bars = await getSymbolBars(symbol);
    return NextResponse.json(
      { symbol, count: bars.length, bars },
      { status: 200 }
    );
  } catch (err) {
    log.error("api.historical", "bars.error", { error: err, symbol });
    return NextResponse.json(
      { error: "Failed to load bars" },
      { status: 500 }
    );
  }
}
