import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

// Per-symbol cap on rows we ship to the client. The DB itself caps at
// NEWS_CONFIG.maxItemsPerSymbol; this is a smaller display cap so the
// detail page stays readable.
const MAX_ITEMS = 25;

interface NewsItemDto {
  id: string;
  headline: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string;
}

export async function GET(
  _req: NextRequest,
  ctx: { params: { symbol: string } }
) {
  const symbol = ctx.params.symbol?.toUpperCase();
  if (!symbol || !/^[A-Z0-9.\-^]+$/.test(symbol)) {
    return NextResponse.json({ error: "Invalid symbol" }, { status: 400 });
  }

  try {
    const rows = await db.newsItem.findMany({
      where: { symbol },
      orderBy: { publishedAt: "desc" },
      take: MAX_ITEMS,
    });
    const items: NewsItemDto[] = rows.map((r) => ({
      id: r.id,
      headline: r.headline,
      summary: r.summary,
      source: r.source,
      url: r.url,
      publishedAt: r.publishedAt.toISOString(),
    }));
    return NextResponse.json({ symbol, count: items.length, items });
  } catch (err) {
    log.error("api.news", "fetch.error", { symbol, error: err });
    return NextResponse.json(
      { error: "Failed to fetch news" },
      { status: 500 }
    );
  }
}
