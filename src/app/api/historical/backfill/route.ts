// Phase 15a — manual watchlist-wide historical-bars backfill.
//
// POST to trigger a backfill of every watchlist symbol. Long-running
// (~1.5 minutes per 100 symbols at the throttle's spacing) — the
// caller should be prepared to wait. Returns aggregate summary.

import { NextRequest, NextResponse } from "next/server";
import { backfillWatchlist } from "@/lib/historical-bars-source";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

interface BackfillRequestBody {
  years?: number;
}

const DEFAULT_YEARS = 5;
const MIN_YEARS = 1;
const MAX_YEARS = 20;

export async function POST(req: NextRequest) {
  let body: BackfillRequestBody = {};
  try {
    body = (await req.json()) as BackfillRequestBody;
  } catch {
    body = {};
  }

  const years = body.years ?? DEFAULT_YEARS;
  if (
    typeof years !== "number" ||
    !Number.isFinite(years) ||
    years < MIN_YEARS ||
    years > MAX_YEARS
  ) {
    return NextResponse.json(
      {
        error: `Invalid 'years' — must be a number in [${MIN_YEARS}, ${MAX_YEARS}]`,
      },
      { status: 400 }
    );
  }

  try {
    const summary = await backfillWatchlist(years);
    return NextResponse.json(summary, { status: 200 });
  } catch (err) {
    log.error("api.historical", "backfill.error", { error: err });
    return NextResponse.json(
      { error: "Backfill failed" },
      { status: 500 }
    );
  }
}
