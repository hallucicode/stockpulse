"use server";

import { db } from "@/lib/db";
import { getQuote, getQuotes, getHistory } from "@/lib/market-data";
import { analyzeStock, getSellSignal } from "@/lib/analysis";
import { log } from "@/lib/logger";
import { revalidatePath } from "next/cache";
import type { Analysis, PositionWithPL } from "@/types";

// ─── Watchlist ───

export async function getWatchlist() {
  return db.watchlistStock.findMany({ orderBy: { addedAt: "asc" } });
}

export async function addToWatchlist(symbol: string, name: string, sector = "Unknown") {
  const existing = await db.watchlistStock.findUnique({ where: { symbol } });
  if (existing) return existing;

  const stock = await db.watchlistStock.create({
    data: { symbol: symbol.toUpperCase(), name, sector },
  });
  revalidatePath("/");
  return stock;
}

export async function removeFromWatchlist(symbol: string) {
  // Remove related alerts first
  await db.alert.deleteMany({ where: { symbol } });
  await db.watchlistStock.delete({ where: { symbol } });
  revalidatePath("/");
}

// ─── Single stock detail ───

export async function getStockDetail(symbol: string) {
  const [history, quote] = await Promise.all([
    getHistory(symbol, 90),
    getQuote(symbol),
  ]);

  const analysis = analyzeStock(symbol, history);

  return { quote, analysis, history };
}

// ─── Portfolio ───

export async function getPortfolio(): Promise<PositionWithPL[]> {
  const positions = await db.position.findMany({
    where: { status: "open" },
    include: { stock: true },
    orderBy: { buyDate: "desc" },
  });

  const symbols = [...new Set(positions.map((p) => p.symbol))];
  const quotes = await getQuotes(symbols);
  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));

  // Get analyses for sell signals
  const analysisMap = new Map<string, Analysis>();
  for (const sym of symbols) {
    try {
      const history = await getHistory(sym, 30);
      if (history.length > 5) {
        analysisMap.set(sym, analyzeStock(sym, history));
      }
    } catch (err) {
      // Non-fatal: per-symbol analysis failure shouldn't block the rest of
      // the portfolio response. Position is still returned without analysis.
      log.warn("actions", "analysis.failure", { symbol: sym, error: err });
    }
  }

  return positions.map((p) => {
    const quote = quoteMap.get(p.symbol);
    const currentPrice = quote?.price ?? p.buyPrice;
    const pl = (currentPrice - p.buyPrice) * p.shares;
    const plPct = ((currentPrice - p.buyPrice) / p.buyPrice) * 100;

    const analysis = analysisMap.get(p.symbol);
    const sellSignal = analysis ? getSellSignal(analysis, p.buyPrice) : undefined;

    return {
      id: p.id,
      symbol: p.symbol,
      name: p.stock.name,
      shares: p.shares,
      buyPrice: p.buyPrice,
      buyDate: p.buyDate.toISOString(),
      currentPrice,
      pl,
      plPct,
      status: "open" as const,
      sellSignal: sellSignal ?? undefined,
    };
  });
}

export async function buyStock(
  symbol: string,
  shares: number,
  price: number,
  notes?: string
) {
  const position = await db.position.create({
    data: {
      symbol,
      shares,
      buyPrice: price,
      notes,
      status: "open",
    },
  });
  revalidatePath("/");
  return position;
}

export async function sellStock(positionId: string) {
  // Get current price for the position
  const position = await db.position.findUnique({ where: { id: positionId } });
  if (!position) throw new Error("Position not found");

  let sellPrice = position.buyPrice; // fallback
  try {
    const quote = await getQuote(position.symbol);
    sellPrice = quote.price;
  } catch (err) {
    // Non-fatal: if we can't get a live quote, fall back to buy price so the
    // sell still completes (P&L = 0). Logged for observability.
    log.warn("actions", "sell.quote-fallback", {
      symbol: position.symbol,
      error: err,
    });
  }

  await db.position.update({
    where: { id: positionId },
    data: {
      status: "closed",
      sellPrice,
      sellDate: new Date(),
    },
  });
  revalidatePath("/");
}

export async function removePosition(positionId: string) {
  await db.position.delete({ where: { id: positionId } });
  revalidatePath("/");
}

// ─── Alerts ───

export async function createAlert(
  symbol: string,
  type: string,
  condition: string,
  threshold?: number
) {
  const alert = await db.alert.create({
    data: { symbol, type, condition, threshold },
  });
  revalidatePath("/");
  return alert;
}

export async function getAlerts(symbol?: string) {
  return db.alert.findMany({
    where: symbol ? { symbol, triggered: false } : { triggered: false },
    orderBy: { createdAt: "desc" },
  });
}

// ─── Trade History ───

export async function getTradeHistory() {
  return db.position.findMany({
    where: { status: "closed" },
    include: { stock: true },
    orderBy: { sellDate: "desc" },
    take: 50,
  });
}
