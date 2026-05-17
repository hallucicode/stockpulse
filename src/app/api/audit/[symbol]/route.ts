// Phase 11 — audit-log read endpoint.
//
// JSON-only (no UI yet). Phase 15 (backtest) replays the chronological
// stream of recommendations for a symbol; Phase 18 (decay monitor)
// reads the same data to compare live vs backtest. Both will call this
// endpoint with explicit `from` / `to` ranges; the default 30-day
// window is for ad-hoc human inspection.
//
// Hardening:
//   - Symbol validation matches the existing `/api/news/[symbol]` shape.
//   - Internal `getAuditTrail` caps the row count at `maxReadRows`
//     regardless of caller input, so a runaway query can't ship
//     megabytes back.
//   - 5xx are swallowed into a clean JSON error payload rather than
//     letting Next surface raw exceptions.

import { NextRequest, NextResponse } from "next/server";
import { getAuditTrail } from "@/lib/recommendation-log";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: { symbol: string } }
) {
  const symbol = ctx.params.symbol?.toUpperCase();
  if (!symbol || !/^[A-Z0-9.\-^]+$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  const params = req.nextUrl.searchParams;
  const from = parseDateParam(params.get("from"));
  const to = parseDateParam(params.get("to"));
  const limitRaw = params.get("limit");
  const limit = limitRaw ? clampPositiveInt(Number(limitRaw)) : undefined;

  // Reject malformed date params explicitly — silent fallback would
  // mask a typo in a backtest URL and produce confusing empty results.
  if (params.get("from") && !from) {
    return NextResponse.json(
      { error: "Invalid `from` date" },
      { status: 400 }
    );
  }
  if (params.get("to") && !to) {
    return NextResponse.json(
      { error: "Invalid `to` date" },
      { status: 400 }
    );
  }

  try {
    const rows = await getAuditTrail(symbol, { from, to, limit });
    return NextResponse.json({
      symbol,
      count: rows.length,
      rows,
    });
  } catch (err) {
    log.error("api.audit", "fetch.error", { symbol, error: err });
    return NextResponse.json(
      { error: "Failed to fetch audit trail" },
      { status: 500 }
    );
  }
}

function parseDateParam(raw: string | null): Date | undefined {
  if (raw === null || raw === "") return undefined;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

function clampPositiveInt(n: number): number | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}
