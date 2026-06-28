// Phase 15a — per-symbol summary of stored historical bars.
//
// GET returns { count, summaries: [{ symbol, barCount, firstDate,
// lastDate, gapCount }] }. Drives the /historical page's main table.

import { NextResponse } from "next/server";
import { listSymbolSummaries } from "@/lib/historical-bars-source";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const summaries = await listSymbolSummaries();
    return NextResponse.json(
      { count: summaries.length, summaries },
      { status: 200 }
    );
  } catch (err) {
    log.error("api.historical", "symbols.error", { error: err });
    return NextResponse.json(
      { error: "Failed to load symbol summaries" },
      { status: 500 }
    );
  }
}
