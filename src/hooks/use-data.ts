import { useEffect, useCallback } from "react";
import { useStore } from "./use-store";
import { log } from "@/lib/logger";

const POLL_INTERVAL_MS = 30_000;

export function useDataFetcher() {
  const {
    view,
    setScannerData,
    setScannerLoading,
    setPortfolio,
    setPortfolioLoading,
  } = useStore();

  const fetchScanner = useCallback(async () => {
    try {
      const res = await fetch("/api/scanner");
      if (!res.ok) throw new Error("Scanner fetch failed");
      const json = await res.json();
      // Shape: { stocks, lastUpdated, count, vetoedCount, newsHealth, regime }
      const stocks = json.stocks ?? json;
      const lastUpdated = json.lastUpdated ?? null;
      const newsHealth = json.newsHealth ?? null;
      const regime = json.regime ?? null;
      const vetoedCount = json.vetoedCount ?? 0;
      setScannerData(stocks, lastUpdated, newsHealth, regime, vetoedCount);
    } catch (err) {
      log.warn("hooks.use-data", "scanner.fetch.failure", { error: err });
      setScannerLoading(false);
    }
  }, [setScannerData, setScannerLoading]);

  const fetchPortfolio = useCallback(async () => {
    try {
      const res = await fetch("/api/portfolio");
      if (!res.ok) throw new Error("Portfolio fetch failed");
      const data = await res.json();
      setPortfolio(data);
    } catch (err) {
      log.warn("hooks.use-data", "portfolio.fetch.failure", { error: err });
      setPortfolioLoading(false);
    }
  }, [setPortfolio, setPortfolioLoading]);

  // Initial fetch
  useEffect(() => {
    fetchScanner();
    fetchPortfolio();
  }, [fetchScanner, fetchPortfolio]);

  // Poll every 30s for scanner (reads from cache), 30s for portfolio
  useEffect(() => {
    const scannerInterval = setInterval(fetchScanner, POLL_INTERVAL_MS);
    const portfolioInterval = setInterval(fetchPortfolio, POLL_INTERVAL_MS);
    return () => {
      clearInterval(scannerInterval);
      clearInterval(portfolioInterval);
    };
  }, [fetchScanner, fetchPortfolio]);

  return { refetchScanner: fetchScanner, refetchPortfolio: fetchPortfolio };
}

// ─── Trade actions ───

export async function executeBuy(symbol: string, shares: number, price: number) {
  const res = await fetch("/api/trade", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "buy", symbol, shares, price }),
  });
  if (!res.ok) throw new Error("Buy failed");
  return res.json();
}

export async function executeSell(positionId: string) {
  const res = await fetch("/api/trade", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "sell", positionId }),
  });
  if (!res.ok) throw new Error("Sell failed");
  return res.json();
}

export async function executeRemove(positionId: string) {
  const res = await fetch("/api/trade", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "remove", positionId }),
  });
  if (!res.ok) throw new Error("Remove failed");
  return res.json();
}
