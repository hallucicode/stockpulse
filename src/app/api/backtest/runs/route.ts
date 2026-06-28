// Phase 15b — list previously-stored backtest runs.
//
// GET returns { count, runs[] } sorted most-recent first. Drives the
// /backtest history/runs view in 15d; for 15b the page just shows
// the most recent run's result.

import { NextResponse } from "next/server";
import { listBacktestRuns } from "@/lib/backtest-source";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const runs = await listBacktestRuns();
    return NextResponse.json({ count: runs.length, runs }, { status: 200 });
  } catch (err) {
    log.error("api.backtest", "runs.error", { error: err });
    return NextResponse.json(
      { error: "Failed to load runs" },
      { status: 500 }
    );
  }
}
