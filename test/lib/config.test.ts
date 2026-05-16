import { describe, it, expect } from "vitest";
import {
  INDICATOR_CONFIG,
  SCORING_WEIGHTS,
  RECOMMENDATION_THRESHOLDS,
  SELL_SIGNAL_CONFIG,
  FETCHER_CONFIG,
  RISK_CONFIG,
  EARNINGS_CONFIG,
  LOG_PERSISTENCE_CONFIG,
  QUALITY_GATE_CONFIG,
  NEWS_CONFIG,
  FUNDAMENTALS_CONFIG,
  INSIDERS_CONFIG,
  ANALYSTS_CONFIG,
  REGIME_CONFIG,
  CATALYST_CONFIG,
  SECTOR_ROTATION_CONFIG,
  SECTOR_ETF_MAP,
  OPTIONS_CONFIG,
} from "@/lib/config";

describe("config", () => {
  it("exposes RSI thresholds in expected order", () => {
    const { deeplyOversold, approachingOversold, approachingOverbought, deeplyOverbought } =
      INDICATOR_CONFIG.rsi;
    expect(deeplyOversold).toBeLessThan(approachingOversold);
    expect(approachingOversold).toBeLessThan(approachingOverbought);
    expect(approachingOverbought).toBeLessThan(deeplyOverbought);
  });

  it("scoring weights are signed as expected", () => {
    expect(SCORING_WEIGHTS.rsiOversold).toBeGreaterThan(0);
    expect(SCORING_WEIGHTS.rsiOverbought).toBeLessThan(0);
    expect(SCORING_WEIGHTS.bollingerLower).toBeGreaterThan(0);
    expect(SCORING_WEIGHTS.bollingerUpper).toBeLessThan(0);
    expect(SCORING_WEIGHTS.scoreMin).toBeLessThan(SCORING_WEIGHTS.scoreMax);
  });

  it("recommendation thresholds are monotonically decreasing", () => {
    const { strongBuy, buy, sell, strongSell } = RECOMMENDATION_THRESHOLDS;
    expect(strongBuy).toBeGreaterThan(buy);
    expect(buy).toBeGreaterThan(sell);
    expect(sell).toBeGreaterThan(strongSell);
  });

  it("sell signal config uses sane signs", () => {
    expect(SELL_SIGNAL_CONFIG.hardStopLossPct).toBeLessThan(0);
    expect(SELL_SIGNAL_CONFIG.takeProfitPct).toBeGreaterThan(0);
  });

  it("risk config: stop fractions sit in (0, 1)", () => {
    expect(RISK_CONFIG.hardCapStopFraction).toBeGreaterThan(0);
    expect(RISK_CONFIG.hardCapStopFraction).toBeLessThan(1);
    expect(RISK_CONFIG.structuralBuffer).toBeGreaterThan(0);
    expect(RISK_CONFIG.structuralBuffer).toBeLessThanOrEqual(1);
    expect(RISK_CONFIG.riskRewardRatio).toBeGreaterThan(1);
    expect(RISK_CONFIG.maxPositionPct).toBeLessThan(RISK_CONFIG.maxSectorPct);
  });

  it("quality gate has sane Phase 2.5 thresholds", () => {
    expect(QUALITY_GATE_CONFIG.minPriceUsd).toBeGreaterThan(0);
    expect(QUALITY_GATE_CONFIG.minAvgDailyDollarVolume).toBeGreaterThan(0);
    expect(QUALITY_GATE_CONFIG.recentBarsForLiquidity).toBeGreaterThan(0);
    expect(QUALITY_GATE_CONFIG.maxDormantBarRatio).toBeGreaterThan(0);
    expect(QUALITY_GATE_CONFIG.maxDormantBarRatio).toBeLessThanOrEqual(1);
  });

  it("news config: positive intervals and bounded score adjustments", () => {
    expect(NEWS_CONFIG.refreshIntervalMs).toBeGreaterThan(0);
    expect(NEWS_CONFIG.lookbackDays).toBeGreaterThan(0);
    expect(NEWS_CONFIG.diagnosisLookbackDays).toBeGreaterThan(0);
    expect(NEWS_CONFIG.maxItemsPerSymbol).toBeGreaterThan(0);
    // Severity ordering: fraud should be the most negative.
    expect(NEWS_CONFIG.scoreAdjustments.fraud).toBeLessThan(0);
    expect(NEWS_CONFIG.scoreAdjustments.fraud).toBeLessThanOrEqual(
      NEWS_CONFIG.scoreAdjustments.lawsuit
    );
    expect(NEWS_CONFIG.scoreAdjustments.product_launch).toBeGreaterThanOrEqual(0);
  });

  it("insiders config has sane bounds", () => {
    expect(INSIDERS_CONFIG.refreshIntervalMs).toBeGreaterThan(0);
    expect(INSIDERS_CONFIG.clusterMinDistinctBuyers).toBeGreaterThanOrEqual(2);
    expect(INSIDERS_CONFIG.clusterBuyScoreBoost).toBeGreaterThan(0);
  });

  it("analysts config has signed score boosts in expected directions", () => {
    expect(ANALYSTS_CONFIG.upgradeScoreBoost).toBeGreaterThan(0);
    expect(ANALYSTS_CONFIG.downgradeScoreBoost).toBeLessThan(0);
  });

  it("regime config has sensible thresholds", () => {
    expect(REGIME_CONFIG.adxTrendingThreshold).toBeGreaterThan(0);
    expect(REGIME_CONFIG.vixCrisisLevel).toBeGreaterThan(0);
    expect(REGIME_CONFIG.spyTrendDeviationPct).toBeGreaterThan(0);
    expect(REGIME_CONFIG.spyTrendDeviationPct).toBeLessThan(1);
    expect(REGIME_CONFIG.smaPeriod).toBe(200);
    expect(REGIME_CONFIG.historyDays).toBeGreaterThan(REGIME_CONFIG.smaPeriod);
  });

  it("fundamentals config has sane bounds", () => {
    expect(FUNDAMENTALS_CONFIG.refreshIntervalMs).toBeGreaterThan(0);
    expect(FUNDAMENTALS_CONFIG.requestSpacingMs).toBeGreaterThan(0);
    expect(FUNDAMENTALS_CONFIG.microcapThresholdUsd).toBeGreaterThan(0);
    expect(FUNDAMENTALS_CONFIG.maxDebtToEquity).toBeGreaterThan(0);
  });

  it("options config has signed boosts + ordered IV-rank thresholds (Phase 8)", () => {
    expect(OPTIONS_CONFIG.refreshIntervalMs).toBeGreaterThan(0);
    expect(OPTIONS_CONFIG.minHistoryDaysForRank).toBeGreaterThan(0);
    expect(OPTIONS_CONFIG.ivRankLowPercentile).toBeLessThan(
      OPTIONS_CONFIG.ivRankHighPercentile
    );
    // Low IV is bullish, high IV is bearish.
    expect(OPTIONS_CONFIG.ivRankLowBoost).toBeGreaterThan(0);
    expect(OPTIONS_CONFIG.ivRankHighBoost).toBeLessThan(0);
    // Unusual call buying is bullish, unusual puts bearish.
    expect(OPTIONS_CONFIG.unusualCallBoost).toBeGreaterThan(0);
    expect(OPTIONS_CONFIG.unusualPutBoost).toBeLessThan(0);
    // Unusual ratio must exceed 1 (otherwise it's "normal", not unusual).
    expect(OPTIONS_CONFIG.unusualVolumeOiRatio).toBeGreaterThan(1);
    expect(OPTIONS_CONFIG.unusualMinOpenInterest).toBeGreaterThan(0);
    expect(OPTIONS_CONFIG.atmTolerancePct).toBeGreaterThan(0);
    expect(OPTIONS_CONFIG.atmTolerancePct).toBeLessThan(1);
  });

  it("sector rotation config has sane bounds", () => {
    expect(SECTOR_ROTATION_CONFIG.refreshIntervalMs).toBeGreaterThan(0);
    expect(SECTOR_ROTATION_CONFIG.smaPeriod).toBe(200);
    expect(SECTOR_ROTATION_CONFIG.historyDays).toBeGreaterThan(
      SECTOR_ROTATION_CONFIG.smaPeriod
    );
    // Catalyst window must be shorter than the trend definition — a
    // sector that's been up for 6 months shouldn't keep firing the
    // "turning up" signal.
    expect(SECTOR_ROTATION_CONFIG.maxRecentUpBars).toBeLessThan(
      SECTOR_ROTATION_CONFIG.smaPeriod
    );
    expect(SECTOR_ROTATION_CONFIG.minPriorDownBars).toBeGreaterThan(0);
    expect(SECTOR_ROTATION_CONFIG.minPriorUpBars).toBeGreaterThan(0);
  });

  it("sector ETF map covers the app's primary sectors with valid symbols", () => {
    for (const [sector, etf] of Object.entries(SECTOR_ETF_MAP)) {
      expect(sector.length).toBeGreaterThan(0);
      // SPDR sector ETFs (and ITA) are 3- or 4-letter all-uppercase tickers.
      expect(etf).toMatch(/^[A-Z]{3,4}$/);
    }
    // A few representatives we expect to always be present.
    expect(SECTOR_ETF_MAP.Tech).toBe("XLK");
    expect(SECTOR_ETF_MAP.Healthcare).toBe("XLV");
  });

  it("catalyst config: positive weights, sane window, max stars covers types", () => {
    expect(CATALYST_CONFIG.earningsCatalystWindowDays).toBeGreaterThan(0);
    // Insider cluster is the highest-alpha catalyst — must outrank
    // earnings (calendar event) and an analyst upgrade (noisy).
    expect(CATALYST_CONFIG.weights.insider_cluster).toBeGreaterThan(
      CATALYST_CONFIG.weights.earnings_upcoming
    );
    expect(CATALYST_CONFIG.weights.insider_cluster).toBeGreaterThan(
      CATALYST_CONFIG.weights.analyst_upgrade
    );
    for (const w of Object.values(CATALYST_CONFIG.weights)) {
      expect(w).toBeGreaterThan(0);
    }
    // Star cap must accommodate all current catalyst types so a fully-lit
    // stock isn't accidentally truncated.
    expect(CATALYST_CONFIG.maxStars).toBeGreaterThanOrEqual(
      Object.keys(CATALYST_CONFIG.weights).length
    );
    expect(CATALYST_CONFIG.positiveNewsCategories.length).toBeGreaterThan(0);
  });

  it("log retention config has positive values", () => {
    expect(LOG_PERSISTENCE_CONFIG.retentionDays).toBeGreaterThan(0);
    expect(LOG_PERSISTENCE_CONFIG.pruneIntervalMs).toBeGreaterThan(0);
  });

  it("earnings config has sane signs and a positive horizon", () => {
    expect(EARNINGS_CONFIG.imminenceCalendarDays).toBeGreaterThan(0);
    expect(EARNINGS_CONFIG.scoreAdjustment).toBeLessThan(0);
    expect(EARNINGS_CONFIG.fetchHorizonDays).toBeGreaterThan(
      EARNINGS_CONFIG.imminenceCalendarDays
    );
    expect(EARNINGS_CONFIG.refreshIntervalMs).toBeGreaterThan(0);
  });

  it("fetcher config has positive intervals", () => {
    expect(FETCHER_CONFIG.batchSize).toBeGreaterThan(0);
    expect(FETCHER_CONFIG.refreshIntervalMs).toBeGreaterThan(0);
    expect(FETCHER_CONFIG.discoveryIntervalMs).toBeGreaterThan(0);
  });
});
