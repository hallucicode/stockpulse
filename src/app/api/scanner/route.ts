import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { log } from "@/lib/logger";
import { getNewsHealth } from "@/lib/news-source";
import { getCurrentRegime } from "@/lib/regime-source";
import type { Analysis } from "@/types";

export const dynamic = "force-dynamic";

// Shape of each row in the analysis cache after JSON parsing — defined here so
// `any` is not needed in the filter step.
interface CachedScannerStock {
  symbol: string;
  name: string;
  sector: string;
  analysis?: Analysis;
}

export async function GET(req: NextRequest) {
  try {
    // `?includeVetoed=true` opts back in to seeing trash names. Default is
    // strict — Phase 2.5 quality gate hides them entirely.
    const includeVetoed =
      req.nextUrl.searchParams.get("includeVetoed") === "true";

    const [cached, newsHealth, regime] = await Promise.all([
      db.analysisCache.findMany({ orderBy: { fetchedAt: "desc" } }),
      // News health failure must not break the scanner — degrade gracefully.
      getNewsHealth().catch((err) => {
        log.warn("api.scanner", "news-health.failure", { error: err });
        return null;
      }),
      // Regime read failure also non-fatal — UI just hides the pill.
      getCurrentRegime().catch((err) => {
        log.warn("api.scanner", "regime.read.failure", { error: err });
        return null;
      }),
    ]);

    if (cached.length === 0) {
      return NextResponse.json({
        stocks: [],
        lastUpdated: null,
        count: 0,
        vetoedCount: 0,
        newsHealth,
        regime,
      });
    }

    const allParsed = cached.map((c) => ({
      ...(JSON.parse(c.data) as CachedScannerStock),
      fetchedAt: c.fetchedAt.toISOString(),
    }));

    const withValidPrice = allParsed.filter(
      (s) => (s.analysis?.price ?? 0) > 0
    );

    const vetoedCount = withValidPrice.filter(
      (s) => s.analysis?.qualityVeto
    ).length;

    const stocks = includeVetoed
      ? withValidPrice
      : withValidPrice.filter((s) => !s.analysis?.qualityVeto);

    const oldestFetch = cached.reduce(
      (min, c) => (c.fetchedAt < min ? c.fetchedAt : min),
      cached[0].fetchedAt
    );

    return NextResponse.json({
      stocks,
      lastUpdated: oldestFetch.toISOString(),
      count: stocks.length,
      vetoedCount,
      newsHealth,
      regime,
    });
  } catch (err) {
    log.error("api.scanner", "fetch.error", { error: err });
    return NextResponse.json(
      { error: "Failed to fetch scanner data" },
      { status: 500 }
    );
  }
}
