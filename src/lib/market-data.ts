import YahooFinance from "yahoo-finance2";
const yahooFinance = new YahooFinance();
import { db } from "./db";
import { log } from "./logger";
import type { Quote, HistoricalBar } from "@/types";

// ─── Configuration ───
const CACHE_TTL_MS = 60_000; // 1 min cache for quotes
const POLYGON_KEY = process.env.POLYGON_API_KEY;

// Polygon aggregate-bar response shape (subset we use).
// Documented at https://polygon.io/docs/stocks/get_v2_aggs_ticker
interface PolygonBar {
  t: number; // unix ms timestamp
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
}

// ─── Yahoo Finance (primary — no API key needed) ───

export async function getQuote(symbol: string): Promise<Quote> {
  // Check cache first
  const cached = await db.priceCache.findFirst({
    where: { symbol },
    orderBy: { fetchedAt: "desc" },
  });

  if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
    return {
      symbol,
      price: cached.price,
      change: cached.change,
      changePct: cached.changePct,
      high: cached.high,
      low: cached.low,
      open: cached.price, // approx
      prevClose: cached.price - cached.change,
      volume: cached.volume,
    };
  }

  try {
    const result = await yahooFinance.quote(symbol);

    const quote: Quote = {
      symbol,
      price: result.regularMarketPrice ?? 0,
      change: result.regularMarketChange ?? 0,
      changePct: result.regularMarketChangePercent ?? 0,
      high: result.regularMarketDayHigh ?? 0,
      low: result.regularMarketDayLow ?? 0,
      open: result.regularMarketOpen ?? 0,
      prevClose: result.regularMarketPreviousClose ?? 0,
      volume: result.regularMarketVolume ?? 0,
      marketCap: result.marketCap,
    };

    // Cache it
    await db.priceCache.create({
      data: {
        symbol,
        price: quote.price,
        change: quote.change,
        changePct: quote.changePct,
        volume: quote.volume,
        high: quote.high,
        low: quote.low,
      },
    });

    return quote;
  } catch (err) {
    log.warn("market-data", "yahoo.quote.failure", { symbol, error: err });
    // Try Polygon fallback
    if (POLYGON_KEY) return getQuotePolygon(symbol);
    // Return cached even if stale
    if (cached) {
      return {
        symbol,
        price: cached.price,
        change: cached.change,
        changePct: cached.changePct,
        high: cached.high,
        low: cached.low,
        open: cached.price,
        prevClose: cached.price - cached.change,
        volume: cached.volume,
      };
    }
    throw new Error(`No data available for ${symbol}`);
  }
}

export async function getQuotes(symbols: string[]): Promise<Quote[]> {
  // Fetch in parallel with concurrency limit
  const results: Quote[] = [];
  const batchSize = 5;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(getQuote));
    for (const r of batchResults) {
      if (r.status === "fulfilled") results.push(r.value);
    }
  }
  return results;
}

export async function getHistory(
  symbol: string,
  days: number = 60
): Promise<HistoricalBar[]> {
  try {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);

    const result = await yahooFinance.chart(symbol, {
      period1: start,
      period2: end,
      interval: "1d",
    });

    return (result.quotes ?? []).map((bar) => ({
      date: new Date(bar.date).toISOString().split("T")[0],
      open: bar.open ?? 0,
      high: bar.high ?? 0,
      low: bar.low ?? 0,
      close: bar.close ?? 0,
      volume: bar.volume ?? 0,
    }));
  } catch (err) {
    log.warn("market-data", "yahoo.history.failure", { symbol, error: err });
    if (POLYGON_KEY) return getHistoryPolygon(symbol, days);
    return [];
  }
}

// ─── Polygon.io fallback ───

async function getQuotePolygon(symbol: string): Promise<Quote> {
  const res = await fetch(
    `https://api.polygon.io/v2/aggs/ticker/${symbol}/prev?apiKey=${POLYGON_KEY}`
  );
  const data = await res.json();
  const bar = data.results?.[0];
  if (!bar) throw new Error(`Polygon: no data for ${symbol}`);

  return {
    symbol,
    price: bar.c,
    change: bar.c - bar.o,
    changePct: ((bar.c - bar.o) / bar.o) * 100,
    high: bar.h,
    low: bar.l,
    open: bar.o,
    prevClose: bar.o,
    volume: bar.v,
  };
}

async function getHistoryPolygon(
  symbol: string,
  days: number
): Promise<HistoricalBar[]> {
  const end = new Date().toISOString().split("T")[0];
  const start = new Date(Date.now() - days * 86400000).toISOString().split("T")[0];

  const res = await fetch(
    `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${start}/${end}?apiKey=${POLYGON_KEY}&limit=120`
  );
  const data = await res.json();

  return ((data.results ?? []) as PolygonBar[]).map((bar) => ({
    date: new Date(bar.t).toISOString().split("T")[0],
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
  }));
}
