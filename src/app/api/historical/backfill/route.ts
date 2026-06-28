// Phase 15a — manual watchlist-wide historical-bars backfill.
//
// POST to trigger a backfill of every watchlist symbol.
//
// The response is an **NDJSON stream** rather than a single JSON object
// because the watchlist-wide backfill takes ~1.1s per symbol — for a
// 1000-symbol watchlist that's ~18 minutes. A silent 18-minute request
// is a terrible UX; the stream lets the client render live progress
// (current symbol, X/N, ETA, running tallies).
//
// Stream format: one JSON object per line.
//
//   {"kind":"start","total":980,"years":5}
//   {"kind":"progress","symbol":"AAPL","processed":1,"total":980,
//    "barsWrittenThisSymbol":1258,"status":"ok"}
//   ...one per symbol...
//   {"kind":"done","totalSymbols":980,"succeeded":947,"empty":28,
//    "errored":5,"totalBarsWritten":1238450}
//
// Callers that don't care about progress can ignore everything except
// the final `done` line.

import { NextRequest } from "next/server";
import { backfillWatchlist } from "@/lib/historical-bars-source";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
// Backfill can run for ~20 minutes on a large watchlist. Vercel max for
// streaming responses; in dev this has no effect.
export const maxDuration = 1200;

interface BackfillRequestBody {
  years?: number;
}

const DEFAULT_YEARS = 5;
const MIN_YEARS = 1;
const MAX_YEARS = 20;

function jsonLine(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}

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
    return new Response(
      JSON.stringify({
        error: `Invalid 'years' — must be a number in [${MIN_YEARS}, ${MAX_YEARS}]`,
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Emit a "start" envelope before any work begins. Client uses
        // this to size its progress UI from event 0 (avoids a blank
        // panel while the first symbol fetches).
        controller.enqueue(jsonLine({ kind: "start", years }));

        const summary = await backfillWatchlist(years, {
          onSymbol: (event) => {
            controller.enqueue(jsonLine({ kind: "progress", ...event }));
          },
        });

        controller.enqueue(jsonLine({ kind: "done", ...summary }));
        controller.close();
      } catch (err) {
        log.error("api.historical", "backfill.error", { error: err });
        // Surface the failure in the same stream so the client can
        // render it inline rather than treating mid-stream errors as
        // "request just died". Then close the stream cleanly.
        controller.enqueue(
          jsonLine({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          })
        );
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      // Some proxies buffer streams unless told not to. Belt-and-braces.
      "x-accel-buffering": "no",
    },
  });
}
