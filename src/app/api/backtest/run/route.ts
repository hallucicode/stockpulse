// Phase 15b — backtest runner endpoint.
//
// POST to kick off a walk-forward backtest. Returns an NDJSON stream
// (one JSON object per line) so the client can render live progress
// rather than waiting for the full simulation to finish.
//
// Request body shape:
//   {
//     startDate: "YYYY-MM-DD",
//     endDate: "YYYY-MM-DD",
//     startingCapital: 50000,
//     symbols?: string[]    // optional; defaults to entire watchlist
//   }
//
// Stream events:
//   {"kind":"start", "symbolCount":N, "totalDays":M}
//   {"kind":"progress", "day":k, "totalDays":M, "date":"...", "equity":E,
//    "openPositions":n, "tradesClosed":t}
//   ...one per trading day...
//   {"kind":"done", "runId":"...", "result":{...}}
//
// On failure mid-stream:
//   {"kind":"error", "message":"..."}

import { NextRequest } from "next/server";
import { runAndPersistBacktest } from "@/lib/backtest-source";
import { BACKTEST_CONFIG } from "@/lib/config";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 1200;

interface RunRequestBody {
  startDate?: string;
  endDate?: string;
  startingCapital?: number;
  symbols?: string[];
  filters?: {
    minScore?: number;
    minAvgDollarVolume?: number;
    minRiskReward?: number;
  };
}

/** Drop a filter field when it's not a finite positive number. */
function sanitiseFilters(
  raw: RunRequestBody["filters"]
): NonNullable<RunRequestBody["filters"]> | undefined {
  if (!raw) return undefined;
  const out: NonNullable<RunRequestBody["filters"]> = {};
  let any = false;
  for (const key of ["minScore", "minAvgDollarVolume", "minRiskReward"] as const) {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      out[key] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

function jsonLine(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}

function isValidDateString(s: string | undefined): s is string {
  if (typeof s !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime());
}

export async function POST(req: NextRequest) {
  let body: RunRequestBody = {};
  try {
    body = (await req.json()) as RunRequestBody;
  } catch {
    body = {};
  }

  if (!isValidDateString(body.startDate)) {
    return new Response(
      JSON.stringify({ error: "Invalid or missing 'startDate' (expected YYYY-MM-DD)" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }
  if (!isValidDateString(body.endDate)) {
    return new Response(
      JSON.stringify({ error: "Invalid or missing 'endDate' (expected YYYY-MM-DD)" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }
  if (body.endDate < body.startDate) {
    return new Response(
      JSON.stringify({ error: "'endDate' must be on or after 'startDate'" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
  }

  const startingCapital =
    typeof body.startingCapital === "number" &&
    Number.isFinite(body.startingCapital) &&
    body.startingCapital > 0
      ? body.startingCapital
      : BACKTEST_CONFIG.defaultStartingCapital;

  const symbols = Array.isArray(body.symbols) ? body.symbols : undefined;
  const filters = sanitiseFilters(body.filters);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(
          jsonLine({
            kind: "start",
            startDate: body.startDate,
            endDate: body.endDate,
            startingCapital,
            symbolsProvided: symbols?.length ?? null,
          })
        );

        const { runId, result } = await runAndPersistBacktest(
          {
            startDate: body.startDate as string,
            endDate: body.endDate as string,
            startingCapital,
            symbols,
            filters,
          },
          {
            onProgress: (event) => {
              controller.enqueue(jsonLine(event));
            },
          }
        );

        controller.enqueue(jsonLine({ kind: "done", runId, result }));
        controller.close();
      } catch (err) {
        log.error("api.backtest", "run.error", { error: err });
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
      "x-accel-buffering": "no",
    },
  });
}
