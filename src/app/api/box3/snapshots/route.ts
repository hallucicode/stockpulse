// Phase 13 — Box 3 snapshot list endpoint.
//
// Returns historical snapshots, most-recent first. No pagination —
// the user typically takes one snapshot per year + ad-hoc, so the
// list stays small for many years.

import { NextResponse } from "next/server";
import { listSnapshots } from "@/lib/box3-source";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await listSnapshots();
    return NextResponse.json({ count: rows.length, snapshots: rows });
  } catch (err) {
    log.error("api.box3", "snapshots.error", { error: err });
    return NextResponse.json(
      { error: "Failed to fetch snapshots" },
      { status: 500 }
    );
  }
}
