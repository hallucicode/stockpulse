// ─── Market Data ───

export interface Quote {
  symbol: string;
  price: number;
  change: number;
  changePct: number;
  high: number;
  low: number;
  open: number;
  prevClose: number;
  volume: number;
  marketCap?: number;
}

export interface HistoricalBar {
  date: string; // ISO date
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Technical Analysis ───

export interface TechnicalSignal {
  label: string;
  detail: string;
  type: "buy" | "sell" | "neutral";
  weight: number; // -100 to +100
  // Phase 6 — optional for backward compat with cached signals.
  // Drives per-regime weight adjustment in `regime.ts`.
  category?: SignalCategory;
}

// Phase 6 — broad signal family used by the regime-weight adjuster.
export type SignalCategory = "mean_reversion" | "momentum";

// Phase 6 — current market regime, attached to every Analysis once
// background-fetcher reads the latest snapshot.
export type Regime =
  | "trending_up"
  | "trending_down"
  | "ranging"
  | "high_vol_crisis";

export interface RegimeInfo {
  regime: Regime;
  // Multipliers actually applied to this analysis's signal weights.
  // Surfaced for transparency in the UI tooltip + audit logs.
  meanReversionMultiplier: number;
  momentumMultiplier: number;
  buyMultiplier: number;
  sellMultiplier: number;
}

// Phase 3: upcoming earnings info attached to an Analysis.
// `nextDate` is an ISO date (YYYY-MM-DD) at exchange granularity.
// `imminent` mirrors the EARNINGS_CONFIG threshold so the UI doesn't have to
// re-derive it.
export interface EarningsInfo {
  nextDate: string;
  daysUntil: number;
  imminent: boolean;
  epsEstimate?: number;
  hour?: string; // "bmo" | "amc" | "dmh"
}

// Phase 1: stop-loss methods.
export type StopMethod = "atr" | "structural" | "hard_cap";

// Phase 1: risk levels attached to every analysis.
// Optional on the type so consumers reading older cached analyses (pre-Phase 1)
// don't break before the cache refreshes.
export interface RiskLevels {
  atr: number;
  entry: number;
  stop: number;
  stopMethod: StopMethod;
  target: number;
  riskReward: number; // (target - entry) / (entry - stop)
}

export interface Analysis {
  symbol: string;
  price: number;
  rsi: number;
  sma20: number;
  sma50: number;
  bollingerUpper: number;
  bollingerLower: number;
  bollingerMid: number;
  macdLine: number;
  macdSignal: number;
  macdHistogram: number;
  dayChange: number;
  weekChange: number;
  monthChange: number;
  avgDailyVolatility: number;
  compositeScore: number; // -100 (strong sell) to +100 (strong buy)
  recommendation: "STRONG BUY" | "BUY" | "HOLD" | "SELL" | "STRONG SELL";
  signals: TechnicalSignal[];
  // Phase 1 — optional for backward compatibility with cached entries.
  risk?: RiskLevels;
  // Phase 3 — optional; null/undefined means "no known upcoming earnings".
  earnings?: EarningsInfo;
  // Phase 1.5 — quality-gate veto. When set, the stock is hidden from the
  // scanner. Kept in the cache for audit; surfaced via `?includeVetoed=true`.
  qualityVeto?: QualityVeto;
  // Phase 4 — news-driven diagnosis (why is this stock cheap?).
  diagnosis?: DiagnosisInfo;
  // Phase 5 — insider activity summary (cluster buys = big bullish signal).
  insiders?: InsiderActivity;
  // Phase 5 — analyst rating actions (recent upgrades/downgrades).
  analysts?: AnalystActivity;
  // Phase 6 — current market regime + weight multipliers applied.
  regime?: RegimeInfo;
  // Phase 7 — catalyst aggregation (confidence stars + present catalyst types).
  catalysts?: CatalystInfo;
  // Phase 8 — options-market readout (ATM IV, IV rank, P/C, unusual flow).
  options?: OptionsActivity;
  // Phase 7.1 — current sector rotation state for the stock's sector, when
  // a sector ETF proxy is configured (see SECTOR_ETF_MAP). Null/undefined
  // means we don't track this sector or no snapshot exists yet.
  sectorRotation?: SectorRotationInfo;
}

// Phase 7 — discrete catalyst types aggregated by `evaluateCatalysts`.
// New entries here = future Phase 7.x expansions (FDA dates, investor days).
// Adding one means: add weight in CATALYST_CONFIG.weights, add detection
// branch in `evaluateCatalysts`, add a label in the UI tooltip.
export type CatalystType =
  | "earnings_upcoming"
  | "insider_cluster"
  | "analyst_upgrade"
  | "positive_news"
  | "sector_rotation";

// Phase 7.1 — sector rotation state for a single sector ETF.
//   - turning_up    : recently crossed above 200dma after sustained downtrend.
//                     Triggers the bullish `sector_rotation` catalyst.
//   - trending_up   : sustained above 200dma — already in favour (no fresh
//                     catalyst, but visible in the UI).
//   - flat          : near 200dma; no clear direction.
//   - trending_down : sustained below 200dma — out of favour.
//   - turning_down  : recently crossed below 200dma after sustained uptrend.
export type SectorRotationState =
  | "turning_up"
  | "trending_up"
  | "flat"
  | "trending_down"
  | "turning_down";

export interface SectorRotationInfo {
  state: SectorRotationState;
  /** ETF symbol used as the sector proxy (XLK, XLV, …). */
  etfSymbol: string;
  /** Latest close of the ETF — surfaced for the UI tooltip + audit. */
  close: number;
  /** 200-day SMA of the ETF close. */
  sma200: number;
  /** Bars in the current run (above or below 200dma). */
  recentRunBars: number;
}

export interface CatalystInfo {
  /** Sum of CATALYST_CONFIG.weights for each present catalyst. */
  score: number;
  /** Distinct catalyst types currently active for this symbol. */
  present: CatalystType[];
  /** Count of present catalysts (also the star rating in the UI). */
  confidence: number;
}

// Phase 4 — news-driven diagnosis categories.
//
// Order encodes severity / specificity. A headline that hits both `fraud`
// and `earnings_miss` should be classified as `fraud` (more diagnostic /
// more severe). The classifier in `diagnosis.ts` walks the rules array in
// this order and returns the first match.
export type DiagnosisCategory =
  // Severe negatives
  | "fraud"
  | "guidance_cut"
  | "lawsuit"
  | "regulatory_setback"
  | "dividend_cut"
  | "earnings_miss"
  // Moderate negatives
  | "analyst_downgrade"
  | "layoffs"
  // Neutral
  | "leadership_change"
  | "merger"
  // Mild positives
  | "buyback"
  | "dividend_hike"
  | "partnership"
  | "product_launch"
  | "sector_selloff"
  // Strong positives
  | "earnings_beat"
  | "analyst_upgrade"
  | "regulatory_approval"
  // Informational — recognised event with no clear directional signal.
  // Better than "unknown" because it tells the user the classifier saw the
  // news; it just isn't a catalyst worth weighting.
  | "earnings_report"
  | "market_wrap"
  // Defaults
  | "technical_only"
  | "unknown";

export interface DiagnosisInfo {
  category: DiagnosisCategory;
  rationale: string;
  newsCount: number;
  scoreAdjustment: number;
}

export interface QualityVeto {
  /** Short tag for grouping (penny_stock | no_earnings | microcap | ...). */
  reason: string;
  /** Human-readable explanation suitable for UI display. */
  detail: string;
}

// Phase 4.5 — fundamentals snapshot from Finnhub. All fields nullable
// because Finnhub coverage is uneven (especially for non-US listings).
export interface Fundamentals {
  marketCap: number | null;
  peRatio: number | null;
  debtToEquity: number | null;
  freeCashFlowTtm: number | null;
  epsTtm: number | null;
  revenueGrowthYoy: number | null;
  hasReportedEarnings: boolean;
}

// Phase 5 — insider buying summary attached to every Analysis.
export interface InsiderActivity {
  /** ≥2 distinct insiders bought on the open market within the cluster window. */
  hasClusterBuy: boolean;
  /** Distinct buyer count in the cluster window. */
  clusterBuyerCount: number;
  /** Total $ value of insider buys in the score-boost lookback window. */
  recentBuyValueUsd: number;
  /** Last open-market buy date as ISO, or null. */
  lastBuyAt: string | null;
  /** Score adjustment applied to the technical compositeScore. */
  scoreAdjustment: number;
}

// Phase 8 — options market readout attached to every Analysis when we
// have a usable options chain for the symbol. All fields are nullable
// because many tickers (microcaps, OTC, ETFs without options) have no
// usable chain at all — we still attach the row so the UI can render a
// "no options" state and audit can see "we checked".
export interface OptionsActivity {
  /** ATM implied volatility as a fraction (0.35 = 35%). Null when no near-ATM contract. */
  atmIV: number | null;
  /**
   * Percentile of `atmIV` within the trailing IV-rank window.
   * 0..100 once `minHistoryDaysForRank` snapshots have accumulated; null
   * before that (we display IV without a rank).
   */
  ivRank: number | null;
  /** Put volume / call volume across the nearest expiry. Null when no chain. */
  putCallRatio: number | null;
  /** ATM put IV − ATM call IV. Positive = put-side fear premium. Null when ATM strikes missing. */
  skew: number | null;
  /** Volume/OI by side exceeded `OPTIONS_CONFIG.unusualVolumeOiRatio`. */
  unusualCalls: boolean;
  unusualPuts: boolean;
  /** Aggregated near-expiry volume + OI per side (UI tooltip + audit). */
  callVolume: number;
  putVolume: number;
  callOpenInterest: number;
  putOpenInterest: number;
  /** Score adjustment that has already been folded into compositeScore. */
  scoreAdjustment: number;
}

// Phase 5 — analyst-action summary attached to every Analysis.
export interface AnalystActivity {
  recentUpgrades: number;
  recentDowngrades: number;
  /** Most recent rating action in the score-boost window, if any. */
  latest: {
    firm: string;
    action: string;
    fromGrade: string | null;
    toGrade: string | null;
    date: string;
  } | null;
  /** Score adjustment (sum of upgradeBoost + downgradeBoost). */
  scoreAdjustment: number;
}

// ─── Portfolio ───

export interface PositionWithPL {
  id: string;
  symbol: string;
  name: string;
  shares: number;
  buyPrice: number;
  buyDate: string;
  currentPrice: number;
  pl: number;
  plPct: number;
  status: "open" | "closed";
  sellSignal?: { reason: string; urgency: "low" | "medium" | "high" };
}

// ─── Scanner ───

export type SortOption = "score" | "dayChange" | "volatility" | "price";
export type SectorFilter = "All" | string;
