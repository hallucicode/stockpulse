// Single source of truth for all tunable parameters.
//
// Rationale: per CLAUDE.md "Code Quality Rule", no magic numbers in source.
// Every threshold, weight, and interval lives here so it can be:
//   - greppable (one place to find what 25 means)
//   - testable (override in tests)
//   - backtested (Phase 11 will sweep these systematically)
//   - documented (each constant has a name explaining intent)
//
// Adding a new tunable? Define it here, import from here, never inline.

// ─── Indicator parameters ───
export const INDICATOR_CONFIG = {
  rsi: {
    period: 14,
    deeplyOversold: 25,
    approachingOversold: 35,
    approachingOverbought: 65,
    deeplyOverbought: 75,
  },
  bollinger: {
    period: 20,
    stdDevMultiplier: 2,
  },
  sma: {
    short: 20,
    long: 50,
  },
  macd: {
    fastPeriod: 12,
    slowPeriod: 26,
    signalApproximation: 0.8, // simplified signal line — see analysis.ts comment
  },
  weeklyChangeWindow: 5, // bars back for weekly change calc
  monthlyChangeWindow: 22, // bars back for monthly change calc
  volumeSpikeWindow: 20, // lookback for avg-volume comparison
  volumeSpikeMultiple: 2, // last vol > avg × this triggers spike
  capitulationDayDrop: -3, // % day drop required alongside volume spike
} as const;

// ─── Score weights for analyzeStock ───
// Positive = bullish push, negative = bearish push.
// All weights here so backtest-driven re-tuning is one-file.
export const SCORING_WEIGHTS = {
  rsiOversold: 30,
  rsiLow: 15,
  rsiHigh: -15,
  rsiOverbought: -30,
  bollingerLower: 25,
  bollingerUpper: -25,
  smaCrossBullish: 10,
  smaCrossBearish: -10,
  macdBullish: 10,
  macdBearish: -10,
  weeklyDip: 20,
  weeklyRally: -20,
  capitulationVolume: 15,

  weeklyDipThreshold: -12, // % week change to trigger dip bonus
  weeklyRallyThreshold: 15, // % week change to trigger rally penalty

  scoreMin: -100,
  scoreMax: 100,
} as const;

// ─── Composite score → recommendation buckets ───
export const RECOMMENDATION_THRESHOLDS = {
  strongBuy: 40,
  buy: 15,
  // hold: -15 < score < 15
  sell: -15,
  strongSell: -40,
} as const;

// ─── Quality gate (Phase 2.5 — extended red flags) ───
//
// Veto on stocks that aren't *real, tradeable* names — penny stocks,
// degenerate-statistics names, illiquid micro-caps, dormant listings.
// Triggered names are excluded from the scanner output entirely. See
// `analysis.ts` and `/api/scanner`.
//
// Real fundamentals-based filtering ("must have earnings" etc.) is Phase 4.5.
export const QUALITY_GATE_CONFIG = {
  // Penny-stock floor. Sub-$1 names have spread / liquidity / manipulation
  // problems that make every technical signal unreliable.
  minPriceUsd: 1,
  // Liquidity floor. Average daily dollar volume below this means you can't
  // exit at scale without moving the market.
  minAvgDailyDollarVolume: 1_000_000,
  // Window (bars) over which liquidity + dormancy are measured.
  recentBarsForLiquidity: 20,
  // If more than this fraction of the recent window has zero volume, the
  // stock is dormant (listed but not actively traded).
  maxDormantBarRatio: 0.5,
} as const;

// ─── Sell signal thresholds (portfolio) ───
export const SELL_SIGNAL_CONFIG = {
  hardStopLossPct: -15,
  takeProfitPct: 25,
  strongBearishScore: -40,
  bearishScoreLockGains: -15,
  lockGainsMinProfitPct: 5,
  rsiOverboughtSellThreshold: 75,
} as const;

// ─── Risk & position sizing (Phase 1) ───
// Source of truth for stop placement, target ratios, and portfolio guardrails.
// Every value here was a direct call-out in IMPLEMENTATION_PLAN.md Phase 1.
export const RISK_CONFIG = {
  atrPeriod: 14,
  // Multiplier applied to ATR to set the volatility-based stop:
  //   atrStop = entry - atrStopMultiplier × ATR
  atrStopMultiplier: 2,
  // Lookback window (bars) for finding the most recent swing low.
  structuralLookback: 20,
  // Buffer below the swing low (1% — swingLow × 0.99).
  structuralBuffer: 0.99,
  // Hard cap on how much of `entry` we ever risk on a single trade.
  // 0.92 means: stop is never worse than 8% below entry.
  hardCapStopFraction: 0.92,
  // Reward-to-risk ratio for the target. target = entry + (entry - stop) × ratio.
  riskRewardRatio: 3,
  // Default portfolio settings used until a real settings UI exists. The
  // scanner only displays *example* sizing — actual buys still go through the
  // existing trade flow that takes a user-supplied share count.
  defaultPortfolioValue: 10_000,
  riskPerTradePct: 0.01, // risk 1% of capital per trade
  maxPositionPct: 0.10, // cap any single position at 10%
  maxSectorPct: 0.25, // cap any sector at 25%
} as const;

// ─── News + diagnosis (Phase 4) ───
//
// Finnhub `/company-news` ingestion + keyword-based diagnosis. Everything
// degrades gracefully when `FINNHUB_API_KEY` is unset — no logs land in the
// DB beyond a single "skip.no-key" info entry per cycle.
//
// Rate limiting: Finnhub's free tier is **60 req/min**. A naive parallel
// batch easily exceeds that (we hit it at ~5 req/sec on the first prod run
// and got `429 Too Many Requests` for ~half the watchlist). So we go
// strictly serial with a per-request spacing chosen to stay under the cap.
export const NEWS_CONFIG = {
  refreshIntervalMs: 24 * 60 * 60 * 1000,
  lookbackDays: 30,
  diagnosisLookbackDays: 30,
  maxItemsPerSymbol: 50,
  // Spacing between sequential per-symbol calls (ms). 1100ms = ~54 req/min,
  // leaves comfortable headroom under the 60/min Finnhub cap.
  requestSpacingMs: 1100,
  // How often to emit a progress log line during a long serial refresh.
  // 50 symbols × 1.1s spacing = ~55s between progress events — visible to a
  // user watching /logs without flooding the table.
  progressLogEveryN: 50,
  // If we still get a 429 despite the spacing, back off this long before
  // continuing.
  rateLimitBackoffMs: 60_000,
  // The DB-level news-staleness threshold (hours). Above this, /api/scanner
  // reports `news.isStale = true` and the UI surfaces a banner.
  staleThresholdHours: 30,
  // Score adjustments applied to the technical compositeScore based on
  // diagnosis category. Negative numbers downgrade the recommendation.
  scoreAdjustments: {
    // Severe negatives
    fraud: -40,
    guidance_cut: -25,
    lawsuit: -20,
    regulatory_setback: -15,
    dividend_cut: -15,
    earnings_miss: -15,
    // Moderate negatives
    analyst_downgrade: -10,
    layoffs: -5,
    // Neutral
    leadership_change: 0,
    merger: 0,
    // Mild positives
    buyback: 5,
    dividend_hike: 5,
    partnership: 5,
    product_launch: 5,
    sector_selloff: 5,
    // Strong positives
    earnings_beat: 10,
    analyst_upgrade: 10,
    regulatory_approval: 10,
    // Informational — neutral
    earnings_report: 0,
    market_wrap: 0,
    // Defaults
    technical_only: 0,
    unknown: 0,
  },
} as const;

// ─── Fundamentals filter (Phase 4.5) ───
//
// Refreshes Finnhub `/stock/metric?metric=all` weekly and applies hard
// vetoes for "must have earnings", microcap, over-leveraged, and
// cash-burning companies. Same Finnhub key + 60/min rate limit as the news
// + earnings sources — see news-source.ts for the spacing rationale.
export const FUNDAMENTALS_CONFIG = {
  // Weekly refresh — fundamentals don't change intraday and the free tier
  // limit is tight.
  refreshIntervalMs: 7 * 24 * 60 * 60 * 1000,
  // Finnhub's free tier is 60 req/min. Match the news-source spacing.
  requestSpacingMs: 1100,
  rateLimitBackoffMs: 60_000,
  progressLogEveryN: 50,
  // Veto thresholds. Each is a hard rule — vetoed stocks disappear from the
  // scanner.
  microcapThresholdUsd: 50_000_000, // $50M floor
  maxDebtToEquity: 5,
  // How long fundamentals can sit before we consider them stale (days).
  // Used by the health card on /logs.
  staleThresholdDays: 14,
} as const;

// ─── Market regime (Phase 6) ───
//
// Daily classification of the overall market into one of four regimes,
// driving per-signal weight multipliers in `analysis.ts`.
//
// Thresholds chosen as common-knowledge defaults:
//   - VIX > 30 OR 90th-percentile = crisis/elevated fear
//   - SPY > 200-day MA + ADX > 22 = trending up
//   - SPY < 200-day MA + ADX > 22 = trending down
//   - everything else = ranging
//
// All values here would be re-tuned from backtest data in Phase 11.
export const REGIME_CONFIG = {
  // How often to recompute regime. Daily is enough — these indicators
  // move slowly and we want to avoid flickering between regimes.
  refreshIntervalMs: 24 * 60 * 60 * 1000,
  // SPY symbol used for the broad-market reference (Yahoo Finance).
  spySymbol: "SPY",
  // VIX index symbol (caret prefix is Yahoo's index convention).
  vixSymbol: "^VIX",
  // Long lookback so 200-day MA and ADX have enough history. ~14 months
  // of trading days keeps the VIX-percentile calculation honest.
  historyDays: 320,
  // ADX period (industry standard).
  adxPeriod: 14,
  // SMA window for SPY trend reference (industry standard 200-day).
  smaPeriod: 200,
  // ADX threshold above which we consider the market to be "trending".
  adxTrendingThreshold: 22,
  // % deviation of SPY from its 200-day MA required to confirm trend
  // direction. 2% in either direction.
  spyTrendDeviationPct: 0.02,
  // VIX level above which we declare crisis regardless of trend.
  vixCrisisLevel: 30,
  // VIX percentile above which we declare crisis even if level is moderate.
  vixCrisisPercentile: 90,
} as const;

// ─── Insider activity (Phase 5, half-1) ───
//
// Pulls Form-4 insider transactions from Finnhub. The single highest-alpha
// signal in retail finance is **cluster buying** — multiple distinct
// insiders buying on the open market within a short window. One CEO buying
// is noise; three different insiders buying within two weeks is meaningful.
export const INSIDERS_CONFIG = {
  // Daily refresh — Form 4 filings happen daily.
  refreshIntervalMs: 24 * 60 * 60 * 1000,
  requestSpacingMs: 1100,
  rateLimitBackoffMs: 60_000,
  progressLogEveryN: 50,
  // How far back to pull from Finnhub on each refresh.
  lookbackDays: 90,
  // Cluster detection: how many distinct buyers within how many days.
  clusterWindowDays: 14,
  clusterMinDistinctBuyers: 2,
  // How long a cluster signal stays "fresh" enough to nudge the score.
  scoreBoostLookbackDays: 30,
  clusterBuyScoreBoost: 15,
} as const;

// ─── Analyst actions (Phase 5, half-2) ───
//
// Pulls upgrades/downgrades from Finnhub `/stock/upgrade-downgrade`. Score
// nudges are deliberately small (±10) — analyst actions have measurable
// short-term alpha but they're noisy.
export const ANALYSTS_CONFIG = {
  refreshIntervalMs: 24 * 60 * 60 * 1000,
  requestSpacingMs: 1100,
  rateLimitBackoffMs: 60_000,
  progressLogEveryN: 50,
  lookbackDays: 90,
  // How recent an upgrade/downgrade has to be to nudge the score.
  scoreBoostLookbackDays: 14,
  upgradeScoreBoost: 10,
  downgradeScoreBoost: -10,
} as const;

// ─── Options market signals (Phase 8) ───
//
// Daily snapshot of each watchlist symbol's options chain via
// yahoo-finance2 (already in our stack — free, no key). We compute:
//   - ATM implied volatility (today's value)
//   - Put/call ratio across the nearest expiry
//   - Skew (put IV − call IV at ATM)
//   - Unusual volume vs open interest by side
// Yahoo doesn't expose historical IV — we **build the series ourselves**
// from OptionsSnapshot rows, so IV rank (percentile of today's IV vs
// trailing window) only becomes meaningful after `minHistoryDaysForRank`
// snapshots have accumulated.
export interface OptionsConfig {
  refreshIntervalMs: number;
  requestSpacingMs: number;
  progressLogEveryN: number;
  ivRankWindowDays: number;
  minHistoryDaysForRank: number;
  ivRankLowPercentile: number;
  ivRankHighPercentile: number;
  ivRankLowBoost: number;
  ivRankHighBoost: number;
  unusualCallBoost: number;
  unusualPutBoost: number;
  unusualVolumeOiRatio: number;
  unusualMinOpenInterest: number;
  atmTolerancePct: number;
}

export const OPTIONS_CONFIG = {
  // Daily refresh — IV moves intraday but ranking is a daily concept.
  refreshIntervalMs: 24 * 60 * 60 * 1000,
  // Spacing between sequential per-symbol yahoo calls (ms). Yahoo isn't
  // strictly rate-limited like Finnhub, but bursts get throttled — keep
  // the same conservative spacing as news/insiders.
  requestSpacingMs: 1100,
  progressLogEveryN: 50,
  // Window (in calendar days) used to compute IV rank. ~252 trading days
  // ≈ 365 calendar; we look up the last 252 snapshots so the percentile
  // reflects "where IV sits in the past year."
  ivRankWindowDays: 365,
  // Minimum snapshots required before IV rank fires score adjustments.
  // Below this threshold we still persist + display IV, just don't
  // pretend the rank is meaningful.
  minHistoryDaysForRank: 60,
  // Score adjustments. Per the plan: cheap IV is mildly bullish (cheap
  // to express directional view), expensive IV is more bearish (move
  // already priced in, high vol-crush risk).
  ivRankLowPercentile: 20,
  ivRankHighPercentile: 80,
  ivRankLowBoost: 5,
  ivRankHighBoost: -10,
  unusualCallBoost: 10,
  unusualPutBoost: -10,
  // Threshold for "unusual" volume per side: volume / open interest.
  // 2.0 is a widely-cited unusual-activity heuristic (a day's volume
  // doubling the standing open interest implies aggressive new flow).
  unusualVolumeOiRatio: 2.0,
  // Minimum total open interest across the side before we even consider
  // "unusual" — guards against `volume=5, oi=2 → ratio=2.5 → unusual!`
  // false positives on illiquid names.
  unusualMinOpenInterest: 100,
  // How tight an ATM call/put has to be to the underlying price (as a
  // fraction of price) to count for skew + IV rank. 5% covers normal
  // strike spacing on liquid names without picking up wing IV.
  atmTolerancePct: 0.05,
} as const;

// ─── Sector rotation (Phase 7.1) ───
//
// Daily classification of each sector ETF (XLK, XLV, XLF, ...) into a
// rotation state. The "turning_up" state — sector recently emerged from a
// long downtrend — fires a +1 catalyst on every stock in that sector via
// Phase 7's catalyst aggregator. Reuses yahoo-finance2 (already in use for
// price history), no new auth or paid tier required.
export const SECTOR_ROTATION_CONFIG = {
  // Daily refresh; sector trends don't change intraday and ETFs are stable.
  refreshIntervalMs: 24 * 60 * 60 * 1000,
  // Enough bars to compute SMA200 with comfortable headroom.
  historyDays: 320,
  // SMA window used as the trend reference (industry standard 200-day).
  smaPeriod: 200,
  // "turning_up" requires the ETF to have recently crossed above its 200dma
  // after a sustained downtrend.
  //   - priorDownBars : how long the ETF was BELOW the 200dma before the
  //                     cross (long enough to be a real reversal, not noise).
  //   - recentUpBars  : how long it's been ABOVE since the cross (long
  //                     enough to confirm the cross stuck; short enough to
  //                     still be the *catalyst* window — we don't want a
  //                     stock that's been recovering for 6 months to keep
  //                     firing this signal).
  minPriorDownBars: 20,
  maxRecentUpBars: 30,
  // "turning_down" mirrors the above (above → below). Not currently used to
  // fire a catalyst (catalysts are bullish events here) but persisted so the
  // /sectors UI and Phase 11 backtest can see it.
  minPriorUpBars: 20,
  maxRecentDownBars: 30,
} as const;

// App sector → sector ETF. App-sector keys come from `mapQuoteToSector` in
// background-fetcher.ts. ETF coverage matches SPDR sector funds (the
// liquid, long-tenured choices). Sectors without a clean single-ETF proxy
// ("Auto", "Other") aren't tracked — stocks in those sectors simply never
// get a sector_rotation catalyst.
export const SECTOR_ETF_MAP: Readonly<Record<string, string>> = {
  Tech: "XLK",
  Healthcare: "XLV",
  Finance: "XLF",
  Energy: "XLE",
  Consumer: "XLY",
  Industrial: "XLI",
  Comm: "XLC",
  REIT: "XLRE",
  Materials: "XLB",
  Utilities: "XLU",
  Aerospace: "ITA",
};

// ─── Sector rotation parameter type ───
//
// `as const` makes literal types like `historyDays: 320` rather than `number`.
// Tests need to pass shrunken configs (smaPeriod=10, historyDays=60) to keep
// fixtures manageable, so pure-function parameters should accept the *shape*
// not the literal-narrow `typeof`. Same pattern for the other two below.
export interface SectorRotationConfig {
  refreshIntervalMs: number;
  historyDays: number;
  smaPeriod: number;
  minPriorDownBars: number;
  maxRecentUpBars: number;
  minPriorUpBars: number;
  maxRecentDownBars: number;
}

// ─── Catalyst scoring (Phase 7) ───
//
// Aggregates the already-decorated catalyst-shaped signals on an Analysis
// (Phase 3 earnings, Phase 5 insiders + analysts, Phase 4 positive-news
// categories) into a single per-symbol view:
//
//   - `catalystScore` — sum of per-catalyst weights, used to rank stocks
//     by how many independent catalysts back the trade.
//   - `confidence`    — count of distinct catalyst types present
//     (0–5 stars in the UI).
//
// Design note: Phase 3/4/5 already nudge `compositeScore` directly when
// each signal lands (e.g. cluster insider buys add +15). Phase 7 therefore
// keeps `compositeScore` untouched and uses the catalyst surface purely for
// the confidence indicator + future ranking — adding `catalystScore × 5` on
// top of the already-adjusted technical score would double-count those same
// signals. The weighted score is still exposed so the UI can sort/rank by
// catalyst density.
export interface CatalystConfig {
  earningsCatalystWindowDays: number;
  weights: {
    earnings_upcoming: number;
    insider_cluster: number;
    analyst_upgrade: number;
    positive_news: number;
    sector_rotation: number;
  };
  positiveNewsCategories: readonly string[];
  maxStars: number;
}

export const CATALYST_CONFIG = {
  // How far ahead an upcoming earnings event counts as a "catalyst" event.
  // Larger than EARNINGS_CONFIG.imminenceCalendarDays (which is the *risk*
  // window — too close to safely hold) because a known earnings date 2–4
  // weeks out is still a tradeable catalyst, not yet a risk.
  earningsCatalystWindowDays: 30,
  // Per-catalyst weights. Insider cluster gets the highest weight because
  // it's the single highest-alpha signal in retail finance (multiple execs
  // buying with their own money in a short window).
  weights: {
    earnings_upcoming: 1,
    insider_cluster: 2,
    analyst_upgrade: 1,
    positive_news: 1,
    // Phase 7.1 — sector turning up after a long downtrend. Macro-level
    // signal: the whole sector is rotating into favour, lifting most boats
    // regardless of single-name story. Weight 1 because it isn't
    // single-name conviction the way an insider cluster is.
    sector_rotation: 1,
  },
  // Diagnosis categories that count as a positive news catalyst. Strong
  // positives only — neutral/informational categories (earnings_report,
  // market_wrap, merger, leadership_change) don't qualify.
  positiveNewsCategories: [
    "earnings_beat",
    "analyst_upgrade",
    "regulatory_approval",
    "product_launch",
    "partnership",
    "buyback",
    "dividend_hike",
  ] as const,
  // Cap on how many stars the UI ever renders. Today's catalyst types
  // produce up to 4; FDA + sector rotation (Phase 7.1) extends to 5.
  maxStars: 5,
} as const;

// ─── Persisted logs ───
// Backs the /logs page. Pruning is run as a daily cron in
// background-fetcher.ts; see also `log-persistence.ts`.
export const LOG_PERSISTENCE_CONFIG = {
  // How many days of LogEntry rows to keep before pruning.
  retentionDays: 7,
  // How often the prune cron fires (24h).
  pruneIntervalMs: 24 * 60 * 60 * 1000,
} as const;

// ─── Recommendation log (Phase 11 — audit foundation) ───
//
// Permanent, replayable timeline of every distinct recommendation the
// system has made. Phase 15 (backtest) replays this to evaluate signal
// quality; Phase 18 (decay monitor) compares live vs backtest from it.
//
// The table is **append-only on change**: a row is written only when
// the canonical key (score, recommendation, regime, present catalysts,
// quality-veto reason) differs from the last row for that symbol.
// Identical re-runs do not write a row.
export const RECOMMENDATION_LOG_CONFIG = {
  // How long rows survive before the prune cron deletes them. 3 years
  // covers Phase 15's longest backtest horizon plus a margin for
  // Phase 18's rolling-window comparisons. Revisit when Phase 17 puts
  // us on Postgres and we have real growth data.
  retentionDays: 3 * 365,
  // How often the prune cron fires.
  pruneIntervalMs: 24 * 60 * 60 * 1000,
  // Default window for the GET /api/audit/[symbol] endpoint when no
  // explicit `from` / `to` query params are supplied. 30 days matches
  // the eyeballable monthly review use-case; backtests will always
  // specify explicit dates.
  defaultReadWindowDays: 30,
  // Hard cap on rows returned by a single API call (defensive — the
  // dedup means even a year of activity is bounded, but a runaway
  // bug shouldn't be able to ship 100k rows in one HTTP response).
  maxReadRows: 5_000,
} as const;

// ─── Earnings calendar (Phase 3) ───
// Suppress / downgrade buy signals when an earnings announcement is imminent.
// Holding through earnings is a coin flip; the app should remove the temptation.
export interface EarningsConfig {
  imminenceCalendarDays: number;
  scoreAdjustment: number;
  applyRecommendationDowngrade: boolean;
  refreshIntervalMs: number;
  fetchHorizonDays: number;
}

export const EARNINGS_CONFIG = {
  // Threshold: an earnings event ≤ this many *calendar* days away counts as
  // "imminent". 7 calendar days ≈ 5 trading days, which matches the plan
  // without us having to enumerate exchange holidays.
  imminenceCalendarDays: 7,
  // Score adjustment applied to imminent-earnings analyses. Negative because
  // the dominant risk in the days before earnings is *unknowable* downside.
  scoreAdjustment: -25,
  // Apply a one-tier downgrade alongside the score nudge — STRONG BUY → BUY,
  // BUY → HOLD, etc. Belt-and-braces: even if the score nudge isn't enough
  // to cross a band, the final recommendation reflects the elevated risk.
  applyRecommendationDowngrade: true,
  // How often the daily earnings-calendar refresh fires. Cheap call on the
  // free tier (one request covers the whole next-month window).
  refreshIntervalMs: 24 * 60 * 60 * 1000,
  // How far ahead we fetch on each refresh. 30 days is plenty for the
  // imminence window plus comfortable buffer.
  fetchHorizonDays: 30,
} as const;

// ─── Data-quality firewall (Phase 0) ───
// Knobs for `./data-quality.ts`. Every threshold here is a heuristic; revisit
// after Phase 11 backtests show how often each gate fires on real data.
export const DATA_QUALITY_CONFIG = {
  // Maximum age (in calendar days) of the latest bar before we treat the
  // ticker as stale (likely delisted or halted).
  staleThresholdDays: 7,
  // Single-day close-to-close move (absolute %) above which the bar is
  // suspicious — could be a real earnings move, could be an unannounced
  // split. Flagged for review; not automatically rejected.
  hugeGapAbsPct: 30,
  // Number of consecutive zero-volume bars that constitutes a "halt run".
  haltRunBars: 3,
  // How many of the most-recent bars to scan for halt runs and gaps.
  recentBarsToCheck: 10,
  // Minimum bars required to do meaningful validation.
  minHistoryBars: 5,
} as const;

// ─── Background fetcher tuning ───
export const FETCHER_CONFIG = {
  batchSize: 10,
  batchDelayMs: 2000,
  refreshIntervalMs: 5 * 60 * 1000,
  discoveryIntervalMs: 30 * 60 * 1000,
  trendingFetchCount: 30,
  historyDaysForRefresh: 60,
  minHistoryBars: 5,
  progressLogEveryNBatches: 10,
} as const;
