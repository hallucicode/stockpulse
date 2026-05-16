/**
 * Cron Alert Checker
 *
 * Run this on a schedule (every 5 min during market hours):
 *   - crontab: *​/5 9-16 * * 1-5 cd /path/to/stockpulse && npx tsx src/lib/cron-alerts.ts
 *   - Or use a process manager like pm2
 *
 * What it does:
 *   1. Fetches current data for all open positions
 *   2. Runs technical analysis
 *   3. Checks for sell signals (stop loss, take profit, bearish signals)
 *   4. Checks watchlist for strong buy signals
 *   5. Sends push notifications via ntfy.sh
 */

import { PrismaClient } from "@prisma/client";
import { analyzeStock, getSellSignal } from "./analysis";
import {
  notifyBuySignal,
  notifySellSignal,
  notifyStopLoss,
} from "./notifications";

// Dynamic imports for market data (ESM compat)
async function main() {
  const { getHistory, getQuote } = await import("./market-data");
  const db = new PrismaClient();

  console.log(`[${new Date().toISOString()}] Running alert check...`);

  try {
    // ─── Check open positions for sell signals ───
    const positions = await db.position.findMany({
      where: { status: "open" },
    });

    for (const pos of positions) {
      try {
        const history = await getHistory(pos.symbol, 30);
        if (history.length < 5) continue;

        const analysis = analyzeStock(pos.symbol, history);
        const signal = getSellSignal(analysis, pos.buyPrice);
        const plPct =
          ((analysis.price - pos.buyPrice) / pos.buyPrice) * 100;

        if (signal) {
          if (signal.urgency === "high" && plPct < -15) {
            await notifyStopLoss(pos.symbol, plPct);
          } else {
            await notifySellSignal(pos.symbol, signal.reason, plPct);
          }
          console.log(
            `  🔴 ${pos.symbol}: ${signal.reason} (${plPct.toFixed(1)}%)`
          );
        } else {
          console.log(
            `  ✅ ${pos.symbol}: OK (${plPct >= 0 ? "+" : ""}${plPct.toFixed(1)}%)`
          );
        }
      } catch (err) {
        console.error(`  ❌ Error checking ${pos.symbol}:`, err);
      }

      // Rate limit: wait 1s between stocks
      await new Promise((r) => setTimeout(r, 1000));
    }

    // ─── Check watchlist for buy opportunities ───
    const watchlist = await db.watchlistStock.findMany();

    for (const stock of watchlist) {
      try {
        const history = await getHistory(stock.symbol, 60);
        if (history.length < 10) continue;

        const analysis = analyzeStock(stock.symbol, history);

        if (analysis.compositeScore >= 40) {
          // Check if we already have an open position
          const existing = await db.position.findFirst({
            where: { symbol: stock.symbol, status: "open" },
          });

          if (!existing) {
            await notifyBuySignal(
              stock.symbol,
              analysis.compositeScore,
              analysis.price
            );
            console.log(
              `  🟢 ${stock.symbol}: STRONG BUY (score: ${analysis.compositeScore})`
            );
          }
        }
      } catch (err) {
        console.error(`  ❌ Error scanning ${stock.symbol}:`, err);
      }

      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await db.$disconnect();
  }

  console.log(`[${new Date().toISOString()}] Alert check complete.\n`);
}

main().catch(console.error);
