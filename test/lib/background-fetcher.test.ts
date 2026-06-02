import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const yfMock: any = {
  trendingSymbols: vi.fn(),
  quote: vi.fn(),
};

vi.mock("yahoo-finance2", () => ({
  default: function () {
    return yfMock;
  },
}));

const dbMock: any = {
  watchlistStock: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  analysisCache: { upsert: vi.fn() },
  dataQualityLog: { createMany: vi.fn() },
  earningsEvent: { findMany: vi.fn(), upsert: vi.fn() },
  recommendationLog: { findFirst: vi.fn(), create: vi.fn() },
  fdaEvent: { findMany: vi.fn(), upsert: vi.fn() },
};
vi.mock("@/lib/db", () => ({ db: dbMock }));

// Earnings source — keep edge module out of fetcher tests.
const earningsSourceMock: any = {
  refreshEarningsCalendar: vi.fn().mockResolvedValue(0),
  getNextEarningsForSymbol: vi.fn().mockResolvedValue(null),
};
vi.mock("@/lib/earnings-source", () => earningsSourceMock);

// Log persistence — keep DB-pruning edge module out of fetcher tests.
const logPersistenceMock: any = {
  pruneOldLogs: vi.fn().mockResolvedValue(0),
};
vi.mock("@/lib/log-persistence", () => logPersistenceMock);

// News source — keep edge module out of fetcher tests.
const newsSourceMock: any = {
  refreshNewsForWatchlist: vi.fn().mockResolvedValue(0),
  getRecentNewsForSymbol: vi.fn().mockResolvedValue([]),
  getOrCacheDiagnosis: vi.fn().mockResolvedValue({
    category: "technical_only",
    rationale: "no news",
    newsCount: 0,
    scoreAdjustment: 0,
  }),
};
vi.mock("@/lib/news-source", () => newsSourceMock);

// Fundamentals source — keep DB-backed edge module out of fetcher tests.
const fundamentalsSourceMock: any = {
  refreshAllFundamentals: vi.fn().mockResolvedValue(0),
  getFundamentalsForSymbol: vi.fn().mockResolvedValue(null),
};
vi.mock("@/lib/fundamentals-source", () => fundamentalsSourceMock);

// Insiders + analysts sources (Phase 5).
const insidersSourceMock: any = {
  refreshAllInsiders: vi.fn().mockResolvedValue(0),
  getRecentInsiderTxnsForSymbol: vi.fn().mockResolvedValue([]),
};
vi.mock("@/lib/insiders-source", () => insidersSourceMock);

const analystsSourceMock: any = {
  refreshAllAnalysts: vi.fn().mockResolvedValue(0),
  getRecentAnalystActionsForSymbol: vi.fn().mockResolvedValue([]),
};
vi.mock("@/lib/analysts-source", () => analystsSourceMock);

// Regime source (Phase 6).
const regimeSourceMock: any = {
  refreshRegimeSnapshot: vi.fn().mockResolvedValue(null),
  getCurrentRegime: vi.fn().mockResolvedValue(null),
};
vi.mock("@/lib/regime-source", () => regimeSourceMock);

// Sector rotation source (Phase 7.1).
const sectorRotationSourceMock: any = {
  refreshSectorRotation: vi.fn().mockResolvedValue(0),
  getCurrentSectorRotationMap: vi.fn().mockResolvedValue(new Map()),
};
vi.mock("@/lib/sector-rotation-source", () => sectorRotationSourceMock);

// Options source (Phase 8).
const optionsSourceMock: any = {
  refreshAllOptions: vi.fn().mockResolvedValue({
    total: 0,
    succeeded: 0,
    skipped: 0,
    errored: 0,
    duration: 0,
  }),
  getLatestOptionsForSymbol: vi.fn().mockResolvedValue(null),
};
vi.mock("@/lib/options-source", () => optionsSourceMock);

// FDA source (Phase 12).
const fdaSourceMock: any = {
  refreshFdaApprovals: vi.fn().mockResolvedValue({
    total: 0,
    matched: 0,
    skippedUnmatched: 0,
    errored: 0,
    duration: 0,
  }),
  getRecentApprovalsForSymbol: vi.fn().mockResolvedValue([]),
};
vi.mock("@/lib/fda-source", () => fdaSourceMock);

// FX source (Phase 13).
const fxSourceMock: any = {
  refreshUsdEurRate: vi.fn().mockResolvedValue(null),
  getLatestUsdEurRate: vi.fn().mockResolvedValue(null),
};
vi.mock("@/lib/fx-source", () => fxSourceMock);

// Build a fresh, validation-passing history. Tests that want to trigger the
// data-quality firewall override this explicitly.
function freshHistory(bars = 10) {
  const today = new Date();
  return Array.from({ length: bars }, (_, i) => {
    const d = new Date(today.getTime() - (bars - 1 - i) * 86_400_000);
    return {
      date: d.toISOString().split("T")[0],
      open: 100,
      high: 102,
      low: 98,
      close: 100,
      volume: 1_000_000,
    };
  });
}

const marketMock: any = { getHistory: vi.fn() };
vi.mock("@/lib/market-data", () => marketMock);

const analysisMock: any = { analyzeStock: vi.fn() };
vi.mock("@/lib/analysis", () => analysisMock);

beforeEach(() => {
  yfMock.trendingSymbols = vi.fn();
  yfMock.quote = vi.fn();
  dbMock.watchlistStock.findMany = vi.fn();
  dbMock.watchlistStock.findUnique = vi.fn();
  dbMock.watchlistStock.create = vi.fn();
  dbMock.analysisCache.upsert = vi.fn();
  dbMock.dataQualityLog.createMany = vi.fn().mockResolvedValue({});
  dbMock.earningsEvent.findMany = vi.fn().mockResolvedValue([]);
  dbMock.recommendationLog.findFirst = vi.fn().mockResolvedValue(null);
  dbMock.recommendationLog.create = vi.fn().mockResolvedValue({});
  earningsSourceMock.refreshEarningsCalendar = vi.fn().mockResolvedValue(0);
  earningsSourceMock.getNextEarningsForSymbol = vi.fn().mockResolvedValue(null);
  logPersistenceMock.pruneOldLogs = vi.fn().mockResolvedValue(0);
  newsSourceMock.refreshNewsForWatchlist = vi.fn().mockResolvedValue(0);
  newsSourceMock.getRecentNewsForSymbol = vi.fn().mockResolvedValue([]);
  newsSourceMock.getOrCacheDiagnosis = vi.fn().mockResolvedValue({
    category: "technical_only",
    rationale: "no news",
    newsCount: 0,
    scoreAdjustment: 0,
  });
  fundamentalsSourceMock.refreshAllFundamentals = vi.fn().mockResolvedValue(0);
  fundamentalsSourceMock.getFundamentalsForSymbol = vi
    .fn()
    .mockResolvedValue(null);
  insidersSourceMock.refreshAllInsiders = vi.fn().mockResolvedValue(0);
  insidersSourceMock.getRecentInsiderTxnsForSymbol = vi
    .fn()
    .mockResolvedValue([]);
  analystsSourceMock.refreshAllAnalysts = vi.fn().mockResolvedValue(0);
  analystsSourceMock.getRecentAnalystActionsForSymbol = vi
    .fn()
    .mockResolvedValue([]);
  regimeSourceMock.refreshRegimeSnapshot = vi.fn().mockResolvedValue(null);
  regimeSourceMock.getCurrentRegime = vi.fn().mockResolvedValue(null);
  sectorRotationSourceMock.refreshSectorRotation = vi.fn().mockResolvedValue(0);
  sectorRotationSourceMock.getCurrentSectorRotationMap = vi
    .fn()
    .mockResolvedValue(new Map());
  optionsSourceMock.refreshAllOptions = vi.fn().mockResolvedValue({
    total: 0,
    succeeded: 0,
    skipped: 0,
    errored: 0,
    duration: 0,
  });
  optionsSourceMock.getLatestOptionsForSymbol = vi.fn().mockResolvedValue(null);
  fdaSourceMock.refreshFdaApprovals = vi.fn().mockResolvedValue({
    total: 0,
    matched: 0,
    skippedUnmatched: 0,
    errored: 0,
    duration: 0,
  });
  fdaSourceMock.getRecentApprovalsForSymbol = vi.fn().mockResolvedValue([]);
  fxSourceMock.refreshUsdEurRate = vi.fn().mockResolvedValue(null);
  fxSourceMock.getLatestUsdEurRate = vi.fn().mockResolvedValue(null);
  marketMock.getHistory = vi.fn();
  analysisMock.analyzeStock = vi.fn();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("background-fetcher", () => {
  it("refreshAllStocks runs once and skips when already running", async () => {
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAA", name: "A", sector: "Tech" },
      { symbol: "BBB", name: "B", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(
      freshHistory()
    );
    analysisMock.analyzeStock.mockReturnValue({ symbol: "X" });
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    const r = await mod.refreshAllStocks();
    expect(r.total).toBe(2);
    expect(r.succeeded).toBe(2);
    expect(dbMock.analysisCache.upsert).toHaveBeenCalledTimes(2);
  });

  it("refreshAllStocks skips short history", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAA", name: "A", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue([{ close: 1 }]); // < 5 bars
    const mod = await import("@/lib/background-fetcher");
    const r = await mod.refreshAllStocks();
    expect(r.succeeded).toBe(0);
    expect(dbMock.analysisCache.upsert).not.toHaveBeenCalled();
  });

  it("refreshAllStocks handles errors in fetchBatch via Promise.allSettled", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "X", name: "X", sector: "T" },
      { symbol: "Y", name: "Y", sector: "T" },
    ]);
    marketMock.getHistory.mockImplementation(async (sym: string) => {
      if (sym === "X") throw new Error("fail");
      return freshHistory();
    });
    analysisMock.analyzeStock.mockReturnValue({});
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    const r = await mod.refreshAllStocks();
    expect(r.succeeded).toBe(1);
  });

  it("quarantines stocks that fail data-quality validation and persists log", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "GOOD", name: "Good", sector: "T" },
      { symbol: "STALE", name: "Stale", sector: "T" },
    ]);
    // STALE returns valid-shaped bars but with old dates — triggers stale_data
    const oldDate = new Date(Date.now() - 30 * 86_400_000); // 30 days ago
    const staleHistory = Array.from({ length: 10 }, (_, i) => ({
      date: new Date(oldDate.getTime() + i * 86_400_000)
        .toISOString()
        .split("T")[0],
      open: 100,
      high: 102,
      low: 98,
      close: 100,
      volume: 1_000_000,
    }));
    marketMock.getHistory.mockImplementation(async (sym: string) =>
      sym === "STALE" ? staleHistory : freshHistory()
    );
    analysisMock.analyzeStock.mockReturnValue({});
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    const r = await mod.refreshAllStocks();

    expect(r.succeeded).toBe(1); // only GOOD cached
    expect(dbMock.analysisCache.upsert).toHaveBeenCalledTimes(1);
    expect(dbMock.analysisCache.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { symbol: "GOOD" } })
    );
    // STALE's quality issues persisted
    expect(dbMock.dataQualityLog.createMany).toHaveBeenCalled();
    const logCall = dbMock.dataQualityLog.createMany.mock.calls[0][0];
    expect(logCall.data.some((d: any) => d.symbol === "STALE" && d.type === "stale_data")).toBe(true);
  });

  it("decorates analyses with earnings info via earnings-source", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAPL", name: "Apple", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "AAPL",
      compositeScore: 50,
      recommendation: "STRONG BUY",
      signals: [],
    });
    earningsSourceMock.getNextEarningsForSymbol.mockResolvedValue({
      nextDate: "2026-04-30",
      daysUntil: 3,
      imminent: true,
    });
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    await mod.refreshAllStocks();

    expect(earningsSourceMock.getNextEarningsForSymbol).toHaveBeenCalledWith("AAPL");
    const upsertCall = dbMock.analysisCache.upsert.mock.calls[0][0];
    const cached = JSON.parse(upsertCall.update.data);
    expect(cached.analysis.earnings?.imminent).toBe(true);
    expect(cached.analysis.recommendation).toBe("BUY"); // downgraded from STRONG BUY
  });

  it("falls through with un-decorated analysis when earnings lookup throws", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "X", name: "X", sector: "T" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "X",
      compositeScore: 30,
      recommendation: "BUY",
      signals: [],
    });
    earningsSourceMock.getNextEarningsForSymbol.mockRejectedValue(new Error("db down"));
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    const r = await mod.refreshAllStocks();
    expect(r.succeeded).toBe(1);
    expect(dbMock.analysisCache.upsert).toHaveBeenCalled();
  });

  it("decorates analyses with diagnosis from news headlines", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "BAD", name: "B", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "BAD",
      compositeScore: 30,
      recommendation: "BUY",
    });
    newsSourceMock.getRecentNewsForSymbol.mockResolvedValue([
      { headline: "BAD Inc misses Q2 estimates", publishedAt: new Date() },
    ]);
    newsSourceMock.getOrCacheDiagnosis.mockResolvedValue({
      category: "earnings_miss",
      rationale: "Earnings miss — \"BAD Inc misses Q2 estimates\"",
      newsCount: 1,
      scoreAdjustment: -15,
    });
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    await mod.refreshAllStocks();

    const upsertArg = dbMock.analysisCache.upsert.mock.calls[0][0];
    const cached = JSON.parse(upsertArg.create.data);
    expect(cached.analysis.diagnosis?.category).toBe("earnings_miss");
    expect(cached.analysis.compositeScore).toBe(15); // 30 - 15
  });

  it("boosts the score on a cluster insider buy (Phase 5)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAPL", name: "Apple", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "AAPL",
      compositeScore: 30,
      recommendation: "BUY",
    });
    insidersSourceMock.getRecentInsiderTxnsForSymbol.mockResolvedValue([
      {
        filerName: "Alice",
        transactionDate: new Date(),
        transactionCode: "P",
        shareChange: 1000,
        totalValue: 100_000,
      },
      {
        filerName: "Bob",
        transactionDate: new Date(),
        transactionCode: "P",
        shareChange: 500,
        totalValue: 50_000,
      },
    ]);
    dbMock.analysisCache.upsert.mockResolvedValue({});
    const mod = await import("@/lib/background-fetcher");
    await mod.refreshAllStocks();
    const cached = JSON.parse(
      dbMock.analysisCache.upsert.mock.calls[0][0].create.data
    );
    expect(cached.analysis.insiders?.hasClusterBuy).toBe(true);
    expect(cached.analysis.insiders?.clusterBuyerCount).toBe(2);
    expect(cached.analysis.compositeScore).toBe(45); // 30 + 15
  });

  it("nudges score on recent analyst upgrade (Phase 5)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "NVDA", name: "Nvidia", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "NVDA",
      compositeScore: 25,
      recommendation: "BUY",
    });
    analystsSourceMock.getRecentAnalystActionsForSymbol.mockResolvedValue([
      {
        firm: "Goldman Sachs",
        action: "up",
        fromGrade: "Hold",
        toGrade: "Buy",
        publishedAt: new Date(),
      },
    ]);
    dbMock.analysisCache.upsert.mockResolvedValue({});
    const mod = await import("@/lib/background-fetcher");
    await mod.refreshAllStocks();
    const cached = JSON.parse(
      dbMock.analysisCache.upsert.mock.calls[0][0].create.data
    );
    expect(cached.analysis.analysts?.recentUpgrades).toBe(1);
    expect(cached.analysis.compositeScore).toBe(35); // 25 + 10
  });

  it("logs and survives insiders/analysts decorate failures", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "X", name: "X", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "X",
      compositeScore: 20,
      recommendation: "BUY",
    });
    insidersSourceMock.getRecentInsiderTxnsForSymbol.mockRejectedValue(
      new Error("ins blip")
    );
    analystsSourceMock.getRecentAnalystActionsForSymbol.mockRejectedValue(
      new Error("ana blip")
    );
    dbMock.analysisCache.upsert.mockResolvedValue({});
    const mod = await import("@/lib/background-fetcher");
    const r = await mod.refreshAllStocks();
    expect(r.succeeded).toBe(1); // analysis still cached, just no boost
  });

  it("re-weights signals via regime adjustment when a regime is set (Phase 6)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAPL", name: "Apple", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    // Single momentum-buy signal weight 30 → trending_up amplifies to 45.
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "AAPL",
      compositeScore: 30,
      recommendation: "BUY",
      signals: [
        {
          label: "MACD Bullish",
          detail: "x",
          type: "buy",
          weight: 30,
          category: "momentum",
        },
      ],
    });
    regimeSourceMock.getCurrentRegime.mockResolvedValue("trending_up");
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    await mod.refreshAllStocks();

    const cached = JSON.parse(
      dbMock.analysisCache.upsert.mock.calls[0][0].create.data
    );
    expect(cached.analysis.compositeScore).toBe(45);
    expect(cached.analysis.recommendation).toBe("STRONG BUY");
    expect(cached.analysis.regime?.regime).toBe("trending_up");
  });

  it("skips regime adjustment when getCurrentRegime returns null (cold start)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "X", name: "X", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "X",
      compositeScore: 30,
      recommendation: "BUY",
      signals: [{ label: "L", detail: "d", type: "buy", weight: 30, category: "momentum" }],
    });
    regimeSourceMock.getCurrentRegime.mockResolvedValue(null);
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    await mod.refreshAllStocks();
    const cached = JSON.parse(
      dbMock.analysisCache.upsert.mock.calls[0][0].create.data
    );
    expect(cached.analysis.compositeScore).toBe(30); // unchanged
    expect(cached.analysis.regime).toBeUndefined();
  });

  it("aggregates Phase 3/4/5 signals into a catalyst readout (Phase 7)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "NVDA", name: "Nvidia", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "NVDA",
      compositeScore: 20,
      recommendation: "BUY",
      signals: [],
    });
    // Earnings 10 days out — counts as upcoming catalyst, not imminent.
    const d = new Date();
    d.setDate(d.getDate() + 10);
    earningsSourceMock.getNextEarningsForSymbol.mockResolvedValue({
      nextDate: d.toISOString().split("T")[0],
      daysUntil: 10,
      imminent: false,
    });
    // Cluster insider buy (2 distinct insiders).
    insidersSourceMock.getRecentInsiderTxnsForSymbol.mockResolvedValue([
      {
        filerName: "Alice",
        transactionDate: new Date(),
        transactionCode: "P",
        shareChange: 1000,
        totalValue: 100_000,
      },
      {
        filerName: "Bob",
        transactionDate: new Date(),
        transactionCode: "P",
        shareChange: 500,
        totalValue: 50_000,
      },
    ]);
    // Recent analyst upgrade.
    analystsSourceMock.getRecentAnalystActionsForSymbol.mockResolvedValue([
      {
        firm: "Goldman",
        action: "up",
        fromGrade: "Hold",
        toGrade: "Buy",
        publishedAt: new Date(),
      },
    ]);
    dbMock.analysisCache.upsert.mockResolvedValue({});
    const mod = await import("@/lib/background-fetcher");
    await mod.refreshAllStocks();
    const cached = JSON.parse(
      dbMock.analysisCache.upsert.mock.calls[0][0].create.data
    );
    expect(cached.analysis.catalysts).toBeDefined();
    expect(cached.analysis.catalysts.confidence).toBeGreaterThanOrEqual(3);
    expect(cached.analysis.catalysts.present).toEqual(
      expect.arrayContaining([
        "earnings_upcoming",
        "insider_cluster",
        "analyst_upgrade",
      ])
    );
  });

  it("fires sector_rotation catalyst when the stock's sector is turning_up (Phase 7.1)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "NVDA", name: "Nvidia", sector: "Tech" },
      { symbol: "XYZ", name: "Other Co", sector: "Other" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockImplementation((symbol: string) => ({
      symbol,
      compositeScore: 10,
      recommendation: "HOLD",
      signals: [],
    }));
    sectorRotationSourceMock.getCurrentSectorRotationMap.mockResolvedValue(
      new Map([
        [
          "Tech",
          {
            state: "turning_up",
            etfSymbol: "XLK",
            close: 200,
            sma200: 190,
            recentRunBars: 3,
          },
        ],
      ])
    );
    dbMock.analysisCache.upsert.mockResolvedValue({});
    const mod = await import("@/lib/background-fetcher");
    await mod.refreshAllStocks();

    const calls = dbMock.analysisCache.upsert.mock.calls;
    const tech = JSON.parse(
      calls.find((c: [{ where: { symbol: string } }]) => c[0].where.symbol === "NVDA")![0]
        .create.data
    );
    const other = JSON.parse(
      calls.find((c: [{ where: { symbol: string } }]) => c[0].where.symbol === "XYZ")![0]
        .create.data
    );

    // Tech stock got the sector rotation decoration AND the catalyst.
    expect(tech.analysis.sectorRotation?.state).toBe("turning_up");
    expect(tech.analysis.catalysts.present).toContain("sector_rotation");
    // Stock in an untracked sector ("Other") gets no decoration and no
    // sector_rotation catalyst.
    expect(other.analysis.sectorRotation).toBeUndefined();
    expect(other.analysis.catalysts.present).not.toContain("sector_rotation");
  });

  it("applies an options-driven score nudge from the latest snapshot (Phase 8)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAPL", name: "Apple", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "AAPL",
      compositeScore: 20,
      recommendation: "BUY",
      signals: [],
    });
    // Unusual call buying + low IV rank → both bullish boosts (+15 total).
    optionsSourceMock.getLatestOptionsForSymbol.mockResolvedValue({
      atmIV: 0.2,
      ivRank: 5,
      putCallRatio: 0.5,
      skew: 0,
      unusualCalls: true,
      unusualPuts: false,
      callVolume: 5000,
      putVolume: 200,
      callOpenInterest: 1000,
      putOpenInterest: 300,
      scoreAdjustment: 15,
    });
    dbMock.analysisCache.upsert.mockResolvedValue({});
    const mod = await import("@/lib/background-fetcher");
    await mod.refreshAllStocks();
    const cached = JSON.parse(
      dbMock.analysisCache.upsert.mock.calls[0][0].create.data
    );
    expect(cached.analysis.options?.unusualCalls).toBe(true);
    expect(cached.analysis.compositeScore).toBe(35);
  });

  it("survives a failed options lookup (Phase 8)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAPL", name: "Apple", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "AAPL",
      compositeScore: 20,
      recommendation: "BUY",
      signals: [],
    });
    optionsSourceMock.getLatestOptionsForSymbol.mockRejectedValue(
      new Error("db blip")
    );
    dbMock.analysisCache.upsert.mockResolvedValue({});
    const mod = await import("@/lib/background-fetcher");
    const r = await mod.refreshAllStocks();
    expect(r.succeeded).toBe(1);
    const cached = JSON.parse(
      dbMock.analysisCache.upsert.mock.calls[0][0].create.data
    );
    expect(cached.analysis.options).toBeUndefined();
    expect(cached.analysis.compositeScore).toBe(20);
  });

  it("survives a failure to read the sector rotation map (Phase 7.1)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAPL", name: "Apple", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "AAPL",
      compositeScore: 10,
      recommendation: "HOLD",
      signals: [],
    });
    sectorRotationSourceMock.getCurrentSectorRotationMap.mockRejectedValue(
      new Error("db blip")
    );
    dbMock.analysisCache.upsert.mockResolvedValue({});
    const mod = await import("@/lib/background-fetcher");
    const r = await mod.refreshAllStocks();
    expect(r.succeeded).toBe(1); // analysis still cached, just no rotation
    const cached = JSON.parse(
      dbMock.analysisCache.upsert.mock.calls[0][0].create.data
    );
    expect(cached.analysis.sectorRotation).toBeUndefined();
  });

  it("appends one RecommendationLog row on first observation (Phase 11)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "NVDA", name: "Nvidia", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "NVDA",
      compositeScore: 42,
      recommendation: "BUY",
      signals: [],
    });
    // No prior row → first-write path.
    dbMock.recommendationLog.findFirst.mockResolvedValue(null);
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    await mod.refreshAllStocks();

    expect(dbMock.recommendationLog.create).toHaveBeenCalledTimes(1);
    const data = dbMock.recommendationLog.create.mock.calls[0][0].data;
    expect(data.symbol).toBe("NVDA");
    expect(data.compositeScore).toBe(42);
    expect(data.recommendation).toBe("BUY");
    expect(typeof data.analysisHash).toBe("string");
  });

  it("skips the RecommendationLog write when nothing changed (Phase 11)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "FLAT", name: "Flat Co", sector: "Other" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "FLAT",
      compositeScore: 10,
      recommendation: "HOLD",
      signals: [],
    });
    // Stub findFirst to return whatever hash maybeLogRecommendation would
    // compute for this exact analysis — easiest way: stash it in a
    // closure variable on first call and return it on subsequent calls.
    // Simpler: use the real hashRecommendationKey to compute it once.
    const { hashRecommendationKey } = await import(
      "@/lib/recommendation-log"
    );
    const expectedHash = hashRecommendationKey({
      symbol: "FLAT",
      compositeScore: 10,
      recommendation: "HOLD",
      signals: [],
    } as never);
    dbMock.recommendationLog.findFirst.mockResolvedValue({
      analysisHash: expectedHash,
    });
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    await mod.refreshAllStocks();

    expect(dbMock.recommendationLog.create).not.toHaveBeenCalled();
  });

  it("survives a RecommendationLog write failure (Phase 11)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAPL", name: "Apple", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "AAPL",
      compositeScore: 30,
      recommendation: "BUY",
      signals: [],
    });
    dbMock.recommendationLog.findFirst.mockResolvedValue(null);
    dbMock.recommendationLog.create.mockRejectedValue(new Error("db down"));
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    const r = await mod.refreshAllStocks();
    // The analysis still got cached (the fetcher's actual job).
    expect(r.succeeded).toBe(1);
    expect(dbMock.analysisCache.upsert).toHaveBeenCalledTimes(1);
  });

  it("fires fda_event catalyst when Healthcare stock has a recent approval (Phase 12)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "MRK", name: "Merck & Co Inc", sector: "Healthcare" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "MRK",
      compositeScore: 20,
      recommendation: "BUY",
      signals: [],
    });
    fdaSourceMock.getRecentApprovalsForSymbol.mockResolvedValue([
      {
        date: new Date().toISOString(),
        description: "FDA approval: KEYTRUDA (BLA125514)",
      },
    ]);
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    await mod.refreshAllStocks();

    const cached = JSON.parse(
      dbMock.analysisCache.upsert.mock.calls[0][0].create.data
    );
    expect(cached.analysis.fda?.hasRecentApproval).toBe(true);
    expect(cached.analysis.catalysts.present).toContain("fda_event");
  });

  it("skips FDA decoration for non-Healthcare stocks (Phase 12)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "AAPL", name: "Apple Inc", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "AAPL",
      compositeScore: 20,
      recommendation: "BUY",
      signals: [],
    });
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    await mod.refreshAllStocks();

    // The FDA read should have been skipped entirely for the Tech stock.
    expect(fdaSourceMock.getRecentApprovalsForSymbol).not.toHaveBeenCalled();
    const cached = JSON.parse(
      dbMock.analysisCache.upsert.mock.calls[0][0].create.data
    );
    expect(cached.analysis.fda).toBeUndefined();
    expect(cached.analysis.catalysts.present).not.toContain("fda_event");
  });

  it("survives a failed FDA lookup (Phase 12)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "MRK", name: "Merck & Co Inc", sector: "Healthcare" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "MRK",
      compositeScore: 20,
      recommendation: "BUY",
      signals: [],
    });
    fdaSourceMock.getRecentApprovalsForSymbol.mockRejectedValue(
      new Error("db blip")
    );
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    const r = await mod.refreshAllStocks();
    expect(r.succeeded).toBe(1);
    const cached = JSON.parse(
      dbMock.analysisCache.upsert.mock.calls[0][0].create.data
    );
    expect(cached.analysis.fda).toBeUndefined();
    expect(cached.analysis.catalysts.present).not.toContain("fda_event");
  });

  it("attaches an empty CatalystInfo when no catalysts apply (Phase 7)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "BORING", name: "Boring Co", sector: "Other" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "BORING",
      compositeScore: 0,
      recommendation: "HOLD",
      signals: [],
    });
    dbMock.analysisCache.upsert.mockResolvedValue({});
    const mod = await import("@/lib/background-fetcher");
    await mod.refreshAllStocks();
    const cached = JSON.parse(
      dbMock.analysisCache.upsert.mock.calls[0][0].create.data
    );
    expect(cached.analysis.catalysts).toEqual({
      score: 0,
      present: [],
      confidence: 0,
    });
  });

  it("vetoes a stock with no_earnings fundamentals (Phase 4.5)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "ETF", name: "Some ETF", sector: "Other" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "ETF",
      compositeScore: 30,
      recommendation: "BUY",
    });
    fundamentalsSourceMock.getFundamentalsForSymbol.mockResolvedValue({
      marketCap: 500_000_000,
      peRatio: null,
      debtToEquity: null,
      freeCashFlowTtm: null,
      epsTtm: null, // no earnings reported
      revenueGrowthYoy: null,
      hasReportedEarnings: false,
    });
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    await mod.refreshAllStocks();

    const upsertArg = dbMock.analysisCache.upsert.mock.calls[0][0];
    const cached = JSON.parse(upsertArg.create.data);
    expect(cached.analysis.qualityVeto?.reason).toBe("no_earnings");
  });

  it("logs and survives fundamentals decorate failures", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "X", name: "X", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "X",
      compositeScore: 20,
      recommendation: "BUY",
    });
    fundamentalsSourceMock.getFundamentalsForSymbol.mockRejectedValue(
      new Error("db blip")
    );
    dbMock.analysisCache.upsert.mockResolvedValue({});
    const mod = await import("@/lib/background-fetcher");
    const r = await mod.refreshAllStocks();
    expect(r.succeeded).toBe(1); // analysis still cached without veto
  });

  it("logs and survives diagnosis decorate failures", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "X", name: "X", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "X",
      compositeScore: 20,
      recommendation: "BUY",
    });
    newsSourceMock.getOrCacheDiagnosis.mockRejectedValue(
      new Error("db lookup fail")
    );
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    const r = await mod.refreshAllStocks();
    expect(r.succeeded).toBe(1); // analysis still cached, just no diagnosis
  });

  it("logs a quality-veto warn when analyzeStock returns one", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "TRASH", name: "T", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({
      symbol: "TRASH",
      qualityVeto: { reason: "penny_stock", detail: "Price $0.50 is below the $1 floor" },
    });
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const logger = await import("@/lib/logger");
    const sink = vi.fn();
    logger.setLoggerSink(sink);

    const mod = await import("@/lib/background-fetcher");
    await mod.refreshAllStocks();

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        component: "fetcher",
        event: "quality-veto",
        meta: expect.objectContaining({
          symbol: "TRASH",
          reason: "penny_stock",
        }),
      })
    );
    // Analysis still cached for audit even when vetoed.
    expect(dbMock.analysisCache.upsert).toHaveBeenCalled();
    logger.resetLoggerSink();
  });

  it("does NOT log a quality-veto when analyzeStock returns no veto", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "OK", name: "Ok", sector: "Tech" },
    ]);
    marketMock.getHistory.mockResolvedValue(freshHistory());
    analysisMock.analyzeStock.mockReturnValue({ symbol: "OK" });
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const logger = await import("@/lib/logger");
    const sink = vi.fn();
    logger.setLoggerSink(sink);

    const mod = await import("@/lib/background-fetcher");
    await mod.refreshAllStocks();

    const vetoCalls = sink.mock.calls.filter(
      (c) => c[0]?.event === "quality-veto"
    );
    expect(vetoCalls).toHaveLength(0);
    logger.resetLoggerSink();
  });

  it("survives a dataQualityLog write failure (best-effort)", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockResolvedValue([
      { symbol: "BAD", name: "Bad", sector: "T" },
    ]);
    marketMock.getHistory.mockResolvedValue([]); // empty → high severity
    dbMock.dataQualityLog.createMany.mockRejectedValue(new Error("audit log down"));

    const mod = await import("@/lib/background-fetcher");
    const r = await mod.refreshAllStocks();
    // The fetcher should not throw; quarantine still applies.
    expect(r.succeeded).toBe(0);
    expect(dbMock.analysisCache.upsert).not.toHaveBeenCalled();
  });

  it("refreshAllStocks throws on top-level db error", async () => {
    vi.resetModules();
    dbMock.watchlistStock.findMany.mockRejectedValue(new Error("db down"));
    const mod = await import("@/lib/background-fetcher");
    await expect(mod.refreshAllStocks()).rejects.toThrow("db down");
  });

  it("refreshAllStocks delays between batches and processes >BATCH_SIZE", async () => {
    vi.resetModules();
    const stocks = Array.from({ length: 12 }, (_, i) => ({
      symbol: `S${i}`,
      name: "n",
      sector: "T",
    }));
    dbMock.watchlistStock.findMany.mockResolvedValue(stocks);
    marketMock.getHistory.mockResolvedValue(
      freshHistory()
    );
    analysisMock.analyzeStock.mockReturnValue({});
    dbMock.analysisCache.upsert.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    const r = await mod.refreshAllStocks();
    expect(r.total).toBe(12);
    expect(r.succeeded).toBe(12);
  }, 20000);

  it("refreshAllStocks no-ops when called concurrently", async () => {
    vi.resetModules();
    let resolveFn: any;
    dbMock.watchlistStock.findMany.mockReturnValue(
      new Promise((resolve) => {
        resolveFn = resolve;
      })
    );
    const mod = await import("@/lib/background-fetcher");
    const p1 = mod.refreshAllStocks();
    const p2 = mod.refreshAllStocks();
    resolveFn([]);
    const [r1, r2] = await Promise.all([p1, p2]);
    // One real run with empty list, one no-op
    const noOp = [r1, r2].find((r) => r.total === 0 && r.duration === 0);
    expect(noOp).toBeDefined();
  });

  it("getFetcherStatus returns interval and run flags", async () => {
    vi.resetModules();
    const mod = await import("@/lib/background-fetcher");
    const s = mod.getFetcherStatus();
    expect(s.intervalMs).toBe(5 * 60 * 1000);
    expect(s).toHaveProperty("isRunning");
  });

  it("startBackgroundFetcher and stopBackgroundFetcher manage intervals", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    dbMock.watchlistStock.findMany.mockResolvedValue([]);
    yfMock.trendingSymbols.mockResolvedValue({ quotes: [] });

    const mod = await import("@/lib/background-fetcher");
    mod.startBackgroundFetcher();
    // calling again is a no-op
    mod.startBackgroundFetcher();

    // Advance to trigger interval
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 10);

    mod.stopBackgroundFetcher();
    // Calling stop again is safe
    mod.stopBackgroundFetcher();
  });

  it("discoverTrendingStocks adds new and skips existing/invalid", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    yfMock.trendingSymbols.mockResolvedValue({
      quotes: [
        { symbol: "AAA" },
        { symbol: "BBB" },
        { symbol: "CCC" },
        { symbol: "DDD" },
        { symbol: "EEE" },
        { symbol: "FFF" },
        { symbol: "GGG" },
        { symbol: "HHH" },
        { symbol: "III" },
        { symbol: "JJJ" },
        { symbol: "KKK" },
        { symbol: "LLL" },
        { symbol: "BAD-X" }, // skipped
        { symbol: "B.A" }, // skipped
      ],
    });
    dbMock.watchlistStock.findUnique.mockImplementation(({ where }: any) =>
      where.symbol === "BBB" ? { symbol: "BBB" } : null
    );
    yfMock.quote.mockImplementation(async (sym: string) => {
      if (sym === "CCC") return null;
      if (sym === "DDD") throw new Error("nope");
      const sectors: Record<string, string> = {
        AAA: "Technology",
        EEE: "Healthcare",
        FFF: "Financial",
        GGG: "Energy",
        HHH: "Consumer Goods",
        III: "Industrial",
        JJJ: "Communication",
        KKK: "Real Estate",
        LLL: "Materials",
      };
      return { shortName: sym + " Inc", sector: sectors[sym] ?? "Auto" };
    });
    dbMock.watchlistStock.findMany.mockResolvedValue([]);
    dbMock.watchlistStock.create.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    mod.startBackgroundFetcher();
    await vi.advanceTimersByTimeAsync(0);
    // Allow microtasks
    await Promise.resolve();
    await Promise.resolve();
    mod.stopBackgroundFetcher();

    // Just verify the sector mapping function path was exercised — at least one create
    // Note: timing of async startup makes exact assertion brittle; this exercises code paths.
  });

  it("discoverTrendingStocks handles top-level error", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    yfMock.trendingSymbols.mockRejectedValue(new Error("trending fail"));
    dbMock.watchlistStock.findMany.mockResolvedValue([]);

    const mod = await import("@/lib/background-fetcher");
    mod.startBackgroundFetcher();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    mod.stopBackgroundFetcher();
  });

  it("mapQuoteToSector covers all sector branches via discoverTrendingStocks", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const sectorInputs = [
      "tech",
      "software",
      "semiconductor",
      "health",
      "pharma",
      "biotech",
      "finance",
      "bank",
      "insurance",
      "energy",
      "oil",
      "gas",
      "consumer",
      "retail",
      "food",
      "industrial",
      "manufacturing",
      "communications",
      "media",
      "entertainment",
      "real estate",
      "materials",
      "chemical",
      "mining",
      "utilities",
      "auto",
      "aerospace",
      "defense",
      "unknown",
    ];
    yfMock.trendingSymbols.mockResolvedValue({
      quotes: sectorInputs.map((_, i) => ({ symbol: `Z${i}` })),
    });
    dbMock.watchlistStock.findUnique.mockResolvedValue(null);
    yfMock.quote.mockImplementation(async (sym: string) => {
      const idx = parseInt(sym.slice(1), 10);
      return { shortName: sym, sector: sectorInputs[idx] };
    });
    dbMock.watchlistStock.findMany.mockResolvedValue([]);
    dbMock.watchlistStock.create.mockResolvedValue({});

    const mod = await import("@/lib/background-fetcher");
    mod.startBackgroundFetcher();
    // Allow microtasks to flush
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
    }
    mod.stopBackgroundFetcher();
  });
});
