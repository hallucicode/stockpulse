// Phase 13 — Box 3 estimate read endpoint.
//
// Returns the live portfolio valuation + Box 3 liability estimate.
// Discriminated response: `{ kind: "ok", ... }` on full data,
// `{ kind: "no-fx-rate" }` when the FX cron hasn't populated a row
// yet (typically only true in the first few minutes after first
// boot).
//
// Every field that derives from the BOX3_CONFIG rates is mirrored on
// the response so the UI can show "rates as of 2026" without
// importing config directly.

import { NextResponse } from "next/server";
import { computeCurrentValuation } from "@/lib/box3-source";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const r = await computeCurrentValuation();
    if (r.kind === "no-fx-rate") {
      return NextResponse.json(
        { kind: "no-fx-rate" as const },
        { status: 200 }
      );
    }
    return NextResponse.json({
      kind: "ok" as const,
      asOf: r.asOf.toISOString(),
      valuation: {
        usdEurRate: r.valuation.usdEurRate,
        totalValueUsd: r.valuation.totalValueUsd,
        totalValueEur: r.valuation.totalValueEur,
        fallbackCount: r.valuation.fallbackCount,
        positions: r.valuation.positions,
      },
      estimate: r.estimate,
    });
  } catch (err) {
    log.error("api.box3", "estimate.error", { error: err });
    return NextResponse.json(
      { error: "Failed to compute Box 3 estimate" },
      { status: 500 }
    );
  }
}
