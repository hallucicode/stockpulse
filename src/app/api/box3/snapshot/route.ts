// Phase 13 — Box 3 snapshot write endpoint.
//
// POST to persist a Box3Snapshot row with the current portfolio
// valuation. Body shape:
//   {
//     label?: string,            // free-text, e.g. "Jan 1 2026"
//     effectiveDate?: string     // ISO date; defaults to today
//   }
//
// Returns the persisted row id + the valuation snapshot. 5xx when
// the FX rate is unavailable (the cron hasn't run yet — the operator
// should wait or trigger it manually).

import { NextRequest, NextResponse } from "next/server";
import { takeSnapshot } from "@/lib/box3-source";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

interface SnapshotRequestBody {
  label?: string;
  effectiveDate?: string;
}

export async function POST(req: NextRequest) {
  let body: SnapshotRequestBody = {};
  try {
    body = (await req.json()) as SnapshotRequestBody;
  } catch {
    // Empty/malformed body is fine — defaults are sensible.
    body = {};
  }

  let effectiveDate: Date | undefined;
  if (body.effectiveDate) {
    const d = new Date(body.effectiveDate);
    if (!Number.isFinite(d.getTime())) {
      return NextResponse.json(
        { error: "Invalid `effectiveDate` (expected ISO date)" },
        { status: 400 }
      );
    }
    effectiveDate = d;
  }

  try {
    const r = await takeSnapshot({
      label: body.label,
      effectiveDate,
    });
    if (r.valuation.kind !== "ok") {
      // Defensive — `takeSnapshot` already throws on no-fx-rate, but
      // this keeps the discriminated-union exhaustive for TS.
      return NextResponse.json(
        { error: "Cannot snapshot without an FX rate" },
        { status: 503 }
      );
    }
    return NextResponse.json({
      id: r.id,
      asOf: r.valuation.asOf.toISOString(),
      totalValueUsd: r.valuation.valuation.totalValueUsd,
      totalValueEur: r.valuation.valuation.totalValueEur,
      estimate: r.valuation.estimate,
    });
  } catch (err) {
    log.error("api.box3", "snapshot.error", { error: err });
    const message =
      err instanceof Error ? err.message : "Failed to take snapshot";
    // FX-rate-missing surfaces as 503 (service partially degraded);
    // every other failure is 500.
    const status = message.includes("FX rate") ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
