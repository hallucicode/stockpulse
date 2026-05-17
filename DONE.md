# StockPulse — Completed Phases

Phases that have shipped. The active roadmap lives in `IMPLEMENTATION_PLAN.md` — when an upcoming phase is finished, **move its section here** so the active plan stays focused on what's still to do.

**Done so far:** Phases 0 through 11 (~41 days of build time).

---

## Phase 0 — Data quality firewall *(critical, do first)* ✅ DONE

**Goal:** Never act on bad data. Yahoo Finance is free and unofficial — it *will* feed garbage. A scanner that recommends BUY on a delisted ticker or a stock that just announced bankruptcy is worse than no scanner.

**Shipped:**
- `src/lib/data-quality.ts` — pure validators (`validateBar`, `validateHistory`, `shouldQuarantine`, `maxSeverity`) at 100% coverage.
- `DATA_QUALITY_CONFIG` in `src/lib/config.ts` — staleness threshold, halt-run length, gap %.
- New Prisma model `DataQualityLog` for audit trail.
- Background fetcher wired to validate every ingest, persist issues, and skip caching for quarantined tickers.
- Live verification: caught 11 `empty_history` (delisted) and 3 `halt_run` tickers on first cycle against real Yahoo data — exactly the failure modes the firewall was designed to catch.

**Deferred to a follow-up sub-phase:**
- Cross-source verification (Stooq / Alpha Vantage) — needs a real API contract decision.
- Corporate-action detection from `adjclose` to downgrade `huge_gap` from "suspicious" to "explained split".
- Auto-removal of chronically failing tickers from the watchlist (today they're just quarantined per cycle and re-tried next refresh).

### Tasks
1. New module `src/lib/data-quality.ts`:
   - **Sanity checks** on every ingested bar:
     - reject single-day moves > 30% not explained by a corporate action
     - reject zero-volume bars (likely halts)
     - reject bars where high < low or close outside [low, high]
   - **Corporate-action awareness**: detect splits, spinoffs, mergers, dividends from Yahoo's adjusted vs. unadjusted close. Quarantine bars during these events until verified.
   - **Halt detection**: flag tickers with consecutive zero-volume days.
   - **Delisting detection**: any ticker returning stale data > 5 trading days old is auto-removed from the scanner universe.
2. **Cross-source verification** for moves > 10% in a day: confirm with Stooq (free) or Alpha Vantage (free tier) before triggering recommendations. If sources disagree → quarantine the symbol.
3. New Prisma table `DataQualityLog { symbol, date, issue, severity, resolved }` for audit.
4. Background fetcher refuses to publish a stock to the scanner if any unresolved data-quality flag exists.

### Tests
- Synthetic bad bars (huge gaps, halts, splits) — verify each is caught.
- End-to-end: feed a delisted ticker → verify it doesn't appear in scanner output.

### Effort: **3 days**. Free.

---

## Phase 1 — Stops & position sizing *(math only, no new APIs)* ✅ DONE

**Goal:** Every recommendation comes with `entry`, `stop`, `target`, `shares`, `portfolio %`.

**Shipped:**
- `calcATR(history, period=14)`, `findSwingLow`, `computeStop`, `computeTarget`, `computeRiskReward`, `computeSize`, `applyGuardrails`, `deriveRiskLevels` — all pure functions in `src/lib/risk.ts`. 100% line coverage.
- `RISK_CONFIG` in `src/lib/config.ts` — ATR period/multiplier, structural buffer, 8% hard cap, 3× reward ratio, 1% per-trade risk, 10% single-position cap, 25% sector cap.
- `Analysis` type extended with optional `risk: RiskLevels` (atr, entry, stop, stopMethod, target, riskReward).
- `analyzeStock` always populates the `risk` packet.
- Scanner card UI shows **Stop / Target / R:R** colour-coded row, hidden on legacy or degenerate data.
- 60+ new tests across `risk.test.ts`, `analysis.test.ts`, `scanner-view.test.tsx`, `config.test.ts`.
- Live verification: 548/549 stocks returned full risk packets. Stop-method distribution: ATR 248, hard_cap 173, structural 127. Sample BUY (INFQ): entry $13.27 → stop $12.21 (8% hard cap) → target $16.45 (+24%) → R:R 3.0×.

**Deferred:**
- Portfolio settings UI (the user-tunable `total_capital`, `risk_per_trade_pct`, etc.). Scanner currently shows risk *levels*; per-user position-size *recommendations* land with the trade card in Phase 14.
- Correlation guardrail — needs price correlations across positions; better fit for Phase 20 (portfolio optimization).

### Tasks
1. Add `calcATR(history, period=14)` to `src/lib/analysis.ts` (true range = max of high-low, |high-prevClose|, |low-prevClose|).
2. New module `src/lib/risk.ts`:
   - `computeStop(entry, atr, swingLow): { stop, method }` — max of ATR stop, structural stop, 8% hard cap.
   - `computeTarget(entry, stop, ratio=3): number`.
   - `computeSize({ portfolioValue, riskPct=0.01, entry, stop }): { shares, dollarRisk }`.
   - `applyGuardrails({ candidate, currentPositions, sectorMix }): { shares, reason? }` — caps single-position %, sector %, correlation.
3. Extend `Analysis` type with `entry`, `stop`, `target`, `atr`, `riskReward`.
4. Wire into `analyzeStock` so every analysis includes risk fields.
5. Update scanner card UI to show **Stop / Target / R:R**.

### Data model
Add `portfolio_settings` table (or local config): `total_capital`, `risk_per_trade_pct`, `max_position_pct`, `max_sector_pct`.

### Tests
- `test/lib/risk.test.ts`: ATR math, stop/target combinations, guardrail edge cases.

### Effort: **2–3 days**. No external dependencies.

---

## Phase 2 — Quality gate v1 (vol + parabolic) — REPLACED by Phase 2.5

The volatility / parabolic-move heuristics were tried and removed. Volatility alone isn't a reliable trash signal — many legitimate names move >10% on a busy news week. Replaced wholesale by Phase 2.5 below, which uses structural red flags (penny, illiquid, dormant) that don't have the same false-positive problem.

---

## Phase 2.5 — Quality gate (extended red flags) ✅ DONE

**Goal:** Veto stocks that aren't *real, tradeable* names — penny stocks, degenerate-statistics names, illiquid micro-caps, dormant listings. Catches the AIXI-class trash without false-positiving on volatile-but-legitimate names.

**Shipped:**
- `checkQualityGate(input)` in `src/lib/analysis.ts` — pure decision over a flat `VETO_RULES` array. Adding rule #N is one entry in the array, not a new conditional.
- Four rules, first match wins:
  - **`penny_stock`** — `price < $1`. Spread / liquidity / manipulation problems on sub-dollar names make every technical signal unreliable.
  - **`degenerate_bollinger`** — `bollingerLower ≤ 0`. When 2σ below the mean goes negative, the bands carry no signal.
  - **`illiquid`** — avg daily dollar volume (price × volume) over the last 20 bars < $1M. You can't exit at scale without moving the market.
  - **`dormant`** — more than 50% of recent bars have zero volume. Listed but not actively traded.
- All thresholds in `QUALITY_GATE_CONFIG` (`src/lib/config.ts`). Easy to retune; one source of truth.
- `Analysis.qualityVeto` field; vetoed analyses still cached for audit.
- `/api/scanner` filters vetoed stocks by default; `?includeVetoed=true` opt-in; `vetoedCount` in the response.
- 9 new tests for the gate; 328 pass total; coverage 99.07 / 94.60 / 97.93 / 99.07.

**Deferred:**
- "Trash count" indicator on the `/logs` page (per-rule veto counts) — useful but not critical.
- Real fundamentals filtering ("must have earnings", market cap, debt) lives in Phase 4.5 below.

---

## Phase 3 — Earnings calendar integration ✅ DONE

**Goal:** Suppress / flag buy signals within 5 trading days of earnings.

**Shipped:**
- Pure module `src/lib/earnings.ts` — `daysUntil`, `isImminent`, `getNextEarnings`, `downgradeRecommendation`, `applyEarningsAdjustment`. 100% line coverage.
- Edge module `src/lib/earnings-source.ts` — `fetchEarningsCalendar`, `refreshEarningsCalendar`, `getNextEarningsForSymbol`. Finnhub free tier. 100% line coverage.
- `EARNINGS_CONFIG` in `src/lib/config.ts` — 7-day imminence window (≈5 trading days), -25 score adjustment, one-tier recommendation downgrade, daily refresh, 30-day fetch horizon.
- New Prisma model `EarningsEvent` with `(symbol, date)` unique index.
- `Analysis.earnings?: EarningsInfo` (nextDate, daysUntil, imminent, epsEstimate, hour).
- Background fetcher: daily `safeEarningsRefresh` cron, plus per-stock decoration (`getNextEarningsForSymbol` → `applyEarningsAdjustment`) immediately after `analyzeStock`. Errors are non-fatal — falls through with the un-decorated analysis.
- Scanner card: amber "📅 EARNINGS IN Nd" badge, hidden when not imminent.
- Graceful degradation when `FINNHUB_API_KEY` is unset: cron logs `refresh.skip.no-key` and returns 0; per-stock lookups still hit the local cache (returns null cleanly), so the system runs as before.
- 41 new tests; live verification with seeded events confirmed end-to-end behaviour: 3 seeded tickers had their `compositeScore` nudged by -25 and recommendations downgraded one tier, and the "Earnings Imminent" signal was appended to each analysis.

**Deferred:**
- Real Finnhub key wiring is per-deployment — set `FINNHUB_API_KEY` in `.env` and the cron starts working without code changes.
- Trading-day-precise (vs calendar-day) imminence — requires an exchange-holiday calendar; current 7-calendar-day approximation matches "≤5 trading days" in the typical case.

### Tasks
1. Sign up for **Finnhub free tier** (60 req/min). Store key in `.env` as `FINNHUB_API_KEY`.
2. New module `src/lib/earnings.ts`:
   - `fetchEarningsCalendar(from, to): Promise<EarningsEvent[]>`
   - `getNextEarnings(symbol): EarningsEvent | null`
3. New Prisma model `EarningsEvent { symbol, date, epsEstimate, time }` with daily refresh.
4. Nightly cron in `background-fetcher.ts` to refresh.
5. In `analyzeStock`, if earnings within 5 trading days:
   - Subtract 25 from score (or downgrade STRONG BUY → BUY).
   - Append warning signal.
6. UI: orange "📅 Earnings in N days" badge.

### Tests
- Mock Finnhub fetch, verify caching and signal injection.

### Effort: **2 days**.

---

## Phase 4 — News + diagnosis pipeline ✅ DONE

**Goal:** For every BUY candidate, classify *why* the stock dropped.

**Shipped:**
- New Prisma models: `NewsItem` (per-symbol cached news, 30-day window) and `DiagnosisCache` (per-symbol classifier output, keyed by content hash).
- Edge module `src/lib/news-source.ts`:
  - `refreshNewsForWatchlist()` — daily Finnhub `/company-news` ingestion, batch + delay throttled.
  - `getRecentNewsForSymbol()` — DB-cached read of recent headlines.
  - `getOrCacheDiagnosis()` — checks `DiagnosisCache` by SHA-1 of headlines; returns cache hit unchanged, otherwise computes + persists. Best-effort: read/write failures fall through to fresh compute.
- Pure module `src/lib/diagnosis.ts`:
  - 9 categories: `fraud | lawsuit | guidance_cut | earnings_miss | merger | product_launch | sector_selloff | technical_only | unknown`.
  - Keyword regex classifier — cheap, deterministic, explainable. First-match-by-priority order encodes severity.
  - `applyDiagnosisAdjustment(analysis, diagnosis)` — applies the score adjustment, recomputes recommendation, never mutates input.
- `NEWS_CONFIG` in `src/lib/config.ts` — refresh interval, lookback, item cap, score adjustments per category.
- Wired into `background-fetcher` after earnings decoration, before quality-veto check.
- Daily news-refresh cron + health spec entry on `/logs`.
- Coloured diagnosis badge on every scanner card (hidden for `technical_only`); tooltip shows the matched headline.
- 25+ new tests across `diagnosis.test.ts` and `news-source.test.ts`. All thresholds met: 362 tests, 98.70/94.61/97.50/98.70.

**Score adjustments** (in `NEWS_CONFIG.scoreAdjustments`):
- `fraud` −40, `guidance_cut` −25, `lawsuit` −20, `earnings_miss` −15
- `merger` 0, `sector_selloff` +5, `product_launch` +5
- `technical_only` 0, `unknown` 0

**Deferred to Phase 21 (cost-bearing AI enhancements):**
- Claude Haiku LLM fallback for `unknown` categories — adds an external API key + per-call cost.
- Per-article sentiment scoring (FinBERT / Claude) — same cost concern; the categorical signal is already useful.

---

## Phase 4.5 — Fundamentals & "must have earnings" filter ✅ DONE

**Goal:** Replace the price-only quality gate with the actual question: *is this a real, viable company that earns money?*

**Shipped:**
- New Prisma model `FundamentalsSnapshot` (per-symbol, weekly refreshed: marketCap, peRatio, debtToEquity, freeCashFlowTtm, epsTtm, revenueGrowthYoy, hasReportedEarnings).
- Edge module `src/lib/fundamentals-source.ts`:
  - `refreshAllFundamentals()` — weekly Finnhub `/stock/metric?metric=all` ingestion, serial with same 1.1s spacing as news (60/min cap), per-symbol error tracking.
  - `getFundamentalsForSymbol()` — DB-cached read; returns `null` for cold-start symbols so they aren't punished before the cron runs.
  - `extractFundamentals()` — pure parser that normalises Finnhub's millions-USD market cap to absolute and defensively maps every field.
- Pure module `src/lib/fundamentals.ts`:
  - `evaluateFundamentals()` — first-match-wins severity-ordered rules.
  - `applyFundamentalsAdjustment()` — returns new Analysis; never overwrites an existing Phase 2.5 veto.
- Five hard veto rules:
  - `no_earnings` — `!hasReportedEarnings || epsTtm == null` (ETFs, dead listings, OTC names)
  - `unknown_fundamentals` — Finnhub returned a row but key fields are blank (non-US coverage gap)
  - `microcap` — market cap < $50M
  - `cash_burning` — `epsTtm < 0 && revenueGrowthYoy < 0` (loss-making AND shrinking)
  - `over_leveraged` — `debtToEquity > 5`
- `FUNDAMENTALS_CONFIG` in `src/lib/config.ts` — single source of truth for thresholds + cron cadence.
- Wired into `background-fetcher` after diagnosis decoration, before veto persistence.
- Weekly cron + new `fundamentals` health card on `/logs`.
- Logger whitelist updated for `fundamentals:refresh.{start,done,progress,skip.no-key}`.

**Live verification:**
- Refreshed 783/786 stocks in 16.6 min (3 errors = non-US listings Finnhub doesn't cover, 0 rate-limited).
- After re-decoration: **178 stocks vetoed, 580 remain visible.**
- Breakdown: 49 over-leveraged, 48 cash-burning, 30 unknown-fundamentals, 18 penny stocks, 15 microcap, 6 no-earnings, plus 12 from Phase 2.5 rules.
- Concrete examples that look right: WEN debt/equity 29× (Wendy's known leveraged), INO loss-making with revenue −70% YoY (exactly what cash_burning is for), AEHL market cap $2.5M (microcap).

**Tests & coverage:**
- 429 tests pass (32 new across `fundamentals.test.ts`, `fundamentals-source.test.ts`, integration in `background-fetcher.test.ts`, config).
- Coverage 98.45 / 94.20 / 97.76 / 98.45 — all thresholds met.

**Deferred:**
- Soft warnings (recent reverse split, P/E > 100) → would lower score without vetoing. Useful but not necessary; the current scanner is already much cleaner.
- Sector-relative valuation thresholds (P/E vs sector median, etc.) → Phase 7-equivalent expansion.

The user-stated bar: **"stock has to have earnings, filter out garbage."**

### Effort: **5–6 days**. Free API. Most work is the per-symbol throttling and the weekly refresh cron.

---

## Phase 5 — Insider buying & analyst rating changes ✅ DONE

**Goal:** Surface two highest-alpha signals in finance: cluster insider buying and recent analyst actions.

**Shipped:**
- New Prisma models: `InsiderTransaction` (symbol, filerName, transactionDate, transactionCode, shareChange, price, totalValue) and `AnalystAction` (symbol, firm, fromGrade, toGrade, action, publishedAt).
- Edge modules:
  - `src/lib/insiders-source.ts` — Finnhub `/stock/insider-transactions` ingest, daily, serial 1.1s spacing. Working on free tier.
  - `src/lib/analysts-source.ts` — **yahoo-finance2 `quoteSummary({ modules: ["upgradeDowngradeHistory"] })`** ingest, daily, serial 1.1s spacing. Same per-firm/per-action data Finnhub charges for, exposed via the Yahoo client we already use for prices. No new auth, no paid tier.
- Pure modules:
  - `src/lib/insiders.ts` — `evaluateInsiderActivity()` detects cluster buys (≥2 distinct insiders within 14 days, code "P" or signed shareChange when code is missing). Filters out option exercises (M), awards (A), gifts (G).
  - `src/lib/analysts.ts` — `evaluateAnalystActivity()` counts upgrades/downgrades within 14 days; +10 for any upgrade, -10 for any downgrade, 0 if both (mixed signal).
- Score adjustments: cluster insider buy = **+15**; recent upgrade = **+10**; recent downgrade = **−10** (independent, can sum).
- Wired into `background-fetcher` after diagnosis, before fundamentals veto. Daily cron + new health cards on `/logs`.
- **Deviations from plan**:
  1. Used Finnhub instead of SEC EDGAR Form 4 for insider transactions (single auth + same throttle pattern).
  2. Used **yahoo-finance2 `quoteSummary`** instead of Finnhub `/stock/upgrade-downgrade` for analyst actions — Finnhub moved that endpoint to a paid plan; Yahoo exposes the same per-firm/per-action data on the free client we already use.
- UI: `👥 INSIDER BUYS (N)` emerald badge for cluster buys; `⬆ UPGRADED` / `⬇ DOWNGRADED` direction-coloured badges. Tooltips show buyer count, total $ value, firm + grade transition.

**Live verification (both pillars now flowing, no paid plan):**
- **Insiders**: 13,718 transactions across 210 distinct symbols. Live cluster-buy detections: GEHC (3 insiders, $5.26M), SPGI (2 insiders, $1.58M), EPAM (6 insiders, $45k). Filter logic correctly distinguishes code=P (counted) from code=M/A (not counted).
- **Analysts**: 2,475 actions ingested across 167 symbols on the first cycle (still running). Live signal volume: **9 stocks with active upgrade boost, 4 with downgrade penalty.** Examples:
  - **GRAB** — China Renaissance: Hold → Buy (upgrade)
  - **TER** — JPMorgan: Neutral → Overweight (upgrade)
  - **HUBS** — Macquarie: Outperform → Neutral (downgrade)
  - **ADBE** — Mizuho: Outperform → Neutral (downgrade)

**Tests & coverage:**
- 475 tests pass (46 new across `insiders.test.ts`, `insiders-source.test.ts`, `analysts.test.ts`, `analysts-source.test.ts`, integration in `background-fetcher.test.ts`, config).
- Coverage 97.30 / 92.92 / 98.02 / 97.30 — all thresholds met.

**Deferred:**
- Major-firm-vs-other weighting for analyst actions (treat Goldman / Morgan Stanley differently from regional banks). Currently every firm counts equally.
- Insider sells as a signal (current code only nudges on cluster *buys*). Sells are noisy — execs often sell for diversification — and the empirical evidence is weaker.
- SEC EDGAR Form 4 direct ingest as a fallback when Finnhub coverage gaps become a problem.

### Effort: **3–4 days**.

---

## Phase 6 — Market regime detection *(critical)* ✅ DONE

**Goal:** Same signal means different things in different markets. Regime-weighted scoring lets the system tilt toward mean-reversion in ranging markets and momentum in trending ones, rather than averaging both into mediocrity.

**Shipped:**
- New Prisma model `RegimeSnapshot` (per-refresh: regime, spyClose, spy200dma, adx14, vixLevel, vixPercentile, fetchedAt — history preserved for future /regime page).
- Edge module `src/lib/regime-source.ts`:
  - `refreshRegimeSnapshot()` — fetches SPY + ^VIX history via yahoo-finance2, computes 200-day SMA, ADX(14), VIX percentile, classifies regime, persists snapshot.
  - `getCurrentRegime()` — reads latest snapshot for orchestrator + scanner API.
- Pure module `src/lib/regime.ts`:
  - `classifyRegime()` — 4 outputs (`trending_up | trending_down | ranging | high_vol_crisis`). Crisis trumps trend; trend requires both direction (SPY vs 200dma) and strength (ADX ≥ 22).
  - `calcADX()` — Wilder's-smoothed Average Directional Index from OHLC.
  - `applyRegimeAdjustment()` — recomputes compositeScore using per-regime weight tables, attaches `regime` metadata to Analysis.
- Per-regime weight tables in `REGIME_WEIGHTS`:
  - `trending_up`: momentum ×1.5, mean-reversion ×0.5
  - `trending_down`: buy ×0.5, sell ×1.5
  - `ranging`: mean-reversion ×1.5, momentum ×0.5
  - `high_vol_crisis`: all ×0.3 (buys especially), sells full strength
- `analyzeStock` now tags every signal with `category: "mean_reversion" | "momentum"` so the adjuster can route weights correctly.
- Wired into `background-fetcher`: regime cron + per-stock adjustment after diagnosis/insider/analyst decoration, before fundamentals veto.
- Health card on `/logs` (`regime` component, daily freshness window).
- UI: regime pill (`📈 TRENDING UP` / `📉 TRENDING DOWN` / `↔ RANGING` / `⚠ HIGH VOL`) on the right side of the page header — visible on every view.
- Status bar updated to show `X tracked · Y filtered out · Z shown` (Phase 2.5 / 4.5 veto count surfaced).

**Live verification:**
- Regime cron fetched SPY + VIX successfully on first run. Classified: **`trending_up`**.
- Inputs: SPY 740.28 vs 200dma 673.96 (+9.8%), ADX 22.96 (just above trend threshold), VIX 18.13 (67th percentile — moderate fear, not crisis).
- 587/588 stocks decorated with regime data on the second cycle (first cycle had `regime: 'unknown'` because cron and stock fetch started in parallel).
- Status bar now reads `833 tracked · 189 filtered out · 644 shown`.

**Tests & coverage:**
- 511 tests pass (36 new across `regime.test.ts`, `regime-source.test.ts`, integration in `background-fetcher.test.ts`, scanner-route + config).
- Coverage: 97.24 / 92.72 / 98.13 / 97.24 — all thresholds met.

**Deferred:**
- `/regime` page with regime-over-time chart (history is persisted; just the visualisation is missing).
- System-wide notification on regime change (push via existing `notifications.ts` channel).
- Per-regime weight re-tuning from backtest data (Phase 15 unlocks this).

### Effort: **4 days**.

---

## Phase 7 — Catalyst scoring ✅ DONE

**Goal:** Aggregate Phases 3–5 into a single **catalyst readout** per ticker.

**Shipped:**
- Pure module `src/lib/catalysts.ts`:
  - `evaluateCatalysts(input)` — given catalyst-shaped fields, returns `{ score, present, confidence }`. Same input → same output, no clock reads.
  - `applyCatalystAdjustment(analysis)` — pure decorator that attaches `CatalystInfo` without mutating the input.
- `CATALYST_CONFIG` in `src/lib/config.ts` — single source of truth: per-catalyst weights, earnings-catalyst window (default 30d), positive-news category list, max stars (5).
- New types `CatalystType` and `CatalystInfo` in `src/types/`.
- Four catalysts in v1 (all using already-available data):
  - **`earnings_upcoming`** — earnings ≤ 30 calendar days out (weight 1). Broader than Phase 3 imminence (≤7d, which is the *risk* window).
  - **`insider_cluster`** — Phase 5 cluster buy (weight 2). Highest weight — single highest-alpha signal in retail finance.
  - **`analyst_upgrade`** — Phase 5 recent upgrade (weight 1).
  - **`positive_news`** — Phase 4 diagnosis in `earnings_beat | analyst_upgrade | regulatory_approval | product_launch | partnership | buyback | dividend_hike` (weight 1).
- Wired into `background-fetcher` after Phase 5/6 decoration, before Phase 4.5 fundamentals veto, so even vetoed-but-cached analyses retain the readout for audit.
- UI: amber `★★★☆☆`-style row in the scanner card right column. Hidden when zero catalysts. Tooltip + `aria-label` list every active catalyst by human-readable label. Cap at `CATALYST_CONFIG.maxStars` so future Phase 7.x additions don't have to touch the renderer.

**Deviation from original plan, deliberate:**
- The plan called for `finalScore = regimeAdjustedTechnical + catalystScore × 5`. We do **not** apply that addition: Phases 3 (earnings imminent), 5 (insider cluster +15, upgrade +10), and 4 (news adjustments) already nudge `compositeScore` directly when their individual signals fire. Multiplying the aggregated catalyst total back into the score would **double-count** those same signals.
- `CatalystInfo.score` is still exposed so the UI can rank by catalyst density and Phase 15 backtest can experiment with it as an alternative score booster — gated on evidence, as the "default to skepticism" principle requires.

**Deferred to Phase 7.1 / Phase 12 (FDA):**
- **Investor-day / conference detection** — still no free data source for corporate-event calendars.
- **FDA / drug-trial dates** — FDA OpenAPI is free but the ticker↔drug-applicant matching is fragile; deferred to Phase 12 once a robust matching strategy is designed.
- **Sector-rotation catalyst** — ✅ shipped in Phase 7.1.
- **Per-catalyst backtest attribution** — once Phase 15 lands, replace the equal weights with backtest-tuned values.

**Tests & coverage:**
- 18 new tests in `test/lib/catalysts.test.ts` covering every catalyst type, boundary cases (same-day earnings, past earnings, mixed positive/negative diagnosis), aggregation, purity, and the config-override path.
- Background-fetcher integration tests verify catalyst data lands in the cache and that an analysis without any catalyst signal still gets an empty `CatalystInfo` (so the UI never sees `undefined`).
- Scanner-view component tests verify star rendering, plural/singular tooltip wording, max-star cap, and absence when no catalysts apply.

### Effort: **2 days**.

---

## Phase 7.1 — Sector rotation catalyst ✅ DONE

**Goal:** Detect when a sector ETF has *recently emerged* from an extended downtrend — that's the catalyst window. Stocks in already-trending sectors don't get the bullish nudge (the catalyst has played out); stocks in newly-recovering sectors do.

**Shipped:**
- Pure module `src/lib/sector-rotation.ts`:
  - `classifySectorRotation(history)` → `{ state, recentRunBars, priorOppositeRunBars, close, sma200 } | null`.
  - Five states: `turning_up | trending_up | flat | trending_down | turning_down`.
  - Decision: `turning_up` requires `priorOppositeRunBars ≥ minPriorDownBars (20)` AND `recentRunBars ≤ maxRecentUpBars (30)`. Mirror for `turning_down`. Sustained runs become `trending_*`; short runs without a prior opposite trend become `flat`.
  - `attachSectorRotation(analysis, info)` — pure decorator.
- Edge module `src/lib/sector-rotation-source.ts`:
  - `refreshSectorRotation()` — daily cron. Iterates SPDR sector ETFs serially, classifies each via the pure module, persists one snapshot per success. Per-sector failure is non-fatal — logged with `error:` and the cron continues.
  - `getCurrentSectorRotationMap()` — returns the latest snapshot per sector as a `Map<sector, SectorRotationInfo>`. Empty map on cold start (sectors without snapshots simply don't get the catalyst).
- New Prisma model `SectorSnapshot` (sector, etfSymbol, state, close, sma200, recentUpBars, priorDownBars, fetchedAt). Indexed on `(sector, fetchedAt)` + `fetchedAt` so the latest-per-sector lookup is cheap.
- `SECTOR_ROTATION_CONFIG` + `SECTOR_ETF_MAP` in `src/lib/config.ts`. Map covers the 11 main app sectors via SPDR ETFs (XLK / XLV / XLF / XLE / XLY / XLI / XLC / XLRE / XLB / XLU) plus ITA for Aerospace. Sectors without a clean single-ETF proxy ("Auto", "Other") simply don't fire the catalyst.
- New `CatalystType` variant `sector_rotation` wired into `evaluateCatalysts`. Only the bullish `turning_up` state fires the catalyst (weight 1 — macro signal, not single-name conviction).
- `background-fetcher` reads the sector-rotation map once per cycle (alongside the regime read), then attaches `Analysis.sectorRotation` for every stock whose sector is tracked before the Phase 7 catalyst aggregator runs.
- Daily cron `safeSectorRotationRefresh` started alongside the existing crons; cleaned up in `stopBackgroundFetcher`.
- `sector-rotation` component added to `HEALTH_SPECS` so the `/logs` page shows the same health card as for other crons.
- Scanner-card tooltip extended with the new "Sector turning up after downtrend" line.

**Tests & coverage:**
- **11** pure tests covering all five states, boundary cases, audit fields, purity, and `attachSectorRotation` behaviour.
- **9** edge tests covering happy path, insufficient history, per-sector failure isolation, plus persistence/readback paths for `turning_up`, `turning_down`, `trending_up`, and `flat` states.
- **2** background-fetcher integration tests: bullish catalyst fires only for tracked sectors; refresh survives a failed sector-rotation read.
- New config + scanner-view tests; updated catalyst test (now expects 5 catalysts max).
- 593 tests pass total. Coverage stays above thresholds (≥95 lines / ≥90 branches).

**Deferred:**
- `/sectors` page charting rotation over time (the schema preserves history).
- Adding `sector_rotation` to the notification-channel triggers ("sector just flipped to turning_up — these N watchlist stocks are now in catalyst windows").
- Phase 12 — FDA / drug-trial catalyst, once the company↔drug matching strategy is robust.

### Effort: **1.5 days**.

---

## Phase 8 — Options market signals ✅ DONE

**Goal:** Smart money expresses views in options *first*. Avoiding trades when IV is at the 80th+ percentile (earnings priced in, vol-crush risk) and pressing trades when IV is at the 20th- percentile (cheap to express the view) is meaningful alpha — and unusual call/put flow is one of the strongest single-name signals retail traders can actually observe.

**Shipped:**
- Pure module `src/lib/options.ts`:
  - `pickAtm`, `aggregateSides`, `putCallRatio`, `calcSkew`, `detectUnusual`, `calcIVRank` — small composable units.
  - `evaluateOptionsActivity(slice, history)` — end-to-end aggregation; `applyOptionsAdjustment(analysis, activity)` — pure decorator.
  - `computeOptionsScoreAdjustment(inputs)` — sum of independent IV-rank + unusual-flow boosts.
- Edge module `src/lib/options-source.ts`:
  - `refreshOptionsForSymbol(symbol)` — pulls the nearest-expiry chain via yahoo-finance2 (free, no new auth), evaluates, persists one `OptionsSnapshot`.
  - `refreshAllOptions()` — daily cron over the watchlist, serial 1.1s spacing (keeps a 600-stock universe under 11 minutes and far below Yahoo's burst limits).
  - `getLatestOptionsForSymbol(symbol)` — read latest snapshot + recompute `ivRank` against fresh historical IV series so rank "warms up" naturally as snapshots accumulate.
  - `getHistoricalIVForSymbol(symbol)` — trailing IV series for rank computation.
- **Data source choice:** Yahoo (already in stack, free) instead of CBOE/Polygon. Yahoo doesn't expose historical IV, so we **build the series ourselves** from one `OptionsSnapshot` per day. IV rank only becomes meaningful after `OPTIONS_CONFIG.minHistoryDaysForRank` (60) snapshots accumulate — below that, the UI shows "rank pending" and no IV-based score adjustment fires.
- New Prisma model `OptionsSnapshot` (symbol, atmIV, putCallRatio, skew, unusualCalls/Puts, callVolume/putVolume/callOpenInterest/putOpenInterest, fetchedAt). Indexed on `(symbol, fetchedAt)` so the trailing-window read is cheap even after a year of accumulation.
- `OPTIONS_CONFIG` in `src/lib/config.ts`:
  - Daily refresh, 1.1s request spacing, 365-day rank window, 60-day minimum history.
  - Score adjustments per the plan: IV rank <20 = **+5**, IV rank >80 = **-10**, unusual calls = **+10**, unusual puts = **-10**.
  - Unusual-flow guard: requires `volume/oi ≥ 2.0` **and** `oi ≥ 100` so we don't false-positive on illiquid names where 5 contracts on 2 OI trivially trip the ratio.
  - 5% strike tolerance for ATM picking — wide enough for normal strike spacing on liquid names, tight enough to avoid wing IV bleed.
- New types `OptionsActivity` (analysis decoration) + internal `OptionContract` / `OptionsChainSlice`.
- `background-fetcher` wires Phase 8 after Phases 3–5 (so the score nudges compose correctly) and before Phase 7.1 sector decoration. Daily `safeOptionsRefresh` cron alongside the others.
- `options` health spec entry on `/logs`; logger whitelist updated for `refresh.start` / `refresh.done` / `refresh.progress`.
- UI on every scanner card:
  - New small row "IV 42% (rank 12) · P/C 0.85", coloured emerald (cheap), amber (expensive), or muted (mid-range). Hidden when no chain.
  - 📞 UNUSUAL CALLS / 🛡 UNUSUAL PUTS badge in the same stack as the other signal badges. Tooltips show the underlying volume/OI numbers.
  - When IV-rank or unusual flow fires, the synthesised signal ("Low IV" / "High IV" / "Unusual Calls" / "Unusual Puts") joins the standard signals list on the card so users see why their score moved.

**Deferred:**
- **Catalyst integration** — `unusual_call_buying` as a Phase 7 catalyst type. Phase 8 already nudges the score directly; adding it as a catalyst would only bump the confidence-star count. Worth doing once Phase 15 backtest data tells us whether the score nudge alone is sufficient.
- **Cross-expiry IV term-structure** — front-month IV vs. 60-day IV (contango/backwardation around earnings is a strong signal). Needs multi-expiry pulls per symbol; current single-call-per-symbol design keeps cost minimal.
- **Block-trade detection** — Yahoo doesn't expose tape detail; needs paid (Polygon/CBOE) data.
- **Greeks beyond IV** (delta, gamma, theta, vega) — Yahoo provides only IV; computing the others requires Black-Scholes + risk-free rate. Defer until the trade card (Phase 14) actually surfaces them.

**Caveats:**
- IV rank is **dormant for the first ~60 days** of running — it returns null and fires no score adjustment until enough snapshots accumulate. UI is honest about this ("rank pending").
- Yahoo's options coverage skews to liquid US listings. Microcaps, OTC names, and ETFs without options simply get `options: null` from the source module — graceful, no score impact, no console noise.
- Yahoo can hiccup on illiquid expiries (sparse strike grid). The 5% ATM tolerance + 100-OI floor keep us from producing meaningful-looking numbers for what is effectively dead names.

**Tests & coverage:**
- **32** pure tests in `test/lib/options.test.ts` covering every helper, boundary case (zero call volume, missing ATM side, non-finite history), and the full end-to-end aggregation.
- **11** edge tests in `test/lib/options-source.test.ts` covering no-chain, empty expiries, invalid underlying, persist-success, persist-failure-but-return-activity, full-watchlist iteration with mixed outcomes, progress logging, history readback, and the recompute-rank-from-fresh-history path in `getLatestOptionsForSymbol`.
- **2** background-fetcher integration tests: bullish options nudge folds into the composite score; refresh survives a failed options lookup.
- **3** new scanner-view tests covering IV-line rendering, rank-pending state, unusual-call/put badges, and the "no chain" hidden state.
- **1** new config test for ordered thresholds + signed boosts.
- Coverage stays above thresholds (≥95 lines/funcs/stmts, ≥90 branches).

### Effort: **5 days**. Most complex external integration.

---

## Phase 9 — Continuous integration ✅ DONE

**Goal:** Stop relying on "remembering to run `npm run test:coverage` locally" for enforcement. The 95% coverage rule and TypeScript correctness should be guarded by automation that blocks merges when they regress.

**Shipped:**
- `.github/workflows/ci.yml` — GitHub Actions workflow that runs on every push to `main` and every PR targeting `main`:
  - Checks out the code (`actions/checkout@v4`).
  - Sets up Node 20 LTS (`actions/setup-node@v4`) with built-in npm cache keyed on `package-lock.json`.
  - `npm ci` — clean reproducible install.
  - `npx prisma generate` — Prisma client is generated, not committed, so the test suite needs it.
  - `npm run typecheck` (= `tsc --noEmit`) — new script.
  - `npm run test:coverage` — runs vitest with v8 coverage, enforcing the thresholds in `vitest.config.ts` (lines ≥ 95, branches ≥ 90, functions ≥ 95, statements ≥ 95). Non-zero exit fails the job.
  - `concurrency: cancel-in-progress` — a newer push on the same ref kills the stale run.
- New `typecheck` script in `package.json`.
- CI status badge in `README.md` linking to the workflow page.

**Latent TypeScript debt cleared as part of this phase** (would otherwise have blocked CI from going green on day 1):
- Production code:
  - `src/lib/options-source.ts` — Yahoo's `yf.options(symbol)` has overloads that can resolve to `Promise<unknown>` in TS's inference path. Introduced an explicit `YahooOptionsResult` interface that captures *exactly* the fields we depend on (documented external boundary, per CLAUDE.md).
  - `src/lib/sector-rotation.ts` — `attachSectorRotation<T>` lacked an `extends object` constraint and TS couldn't verify the null-early-return matched the return type. Added the constraint and an explicit cast on the null branch.
- Test ergonomics:
  - Extracted explicit `CatalystConfig`, `SectorRotationConfig`, `OptionsConfig`, `EarningsConfig` interfaces in `src/lib/config.ts`. The `as const` source-of-truth values are unchanged, but the pure-module function parameters now type their `cfg` against the looser interface — so tests can pass overrides without hitting "number is not literal 2" errors.
- Test files:
  - `test/lib/db.test.ts` + `test/lib/logger.test.ts` — replaced `process.env.NODE_ENV = "..."` with `vi.stubEnv("NODE_ENV", "...")`. Node 20+ types `NODE_ENV` as readonly.
  - `test/lib/earnings.test.ts` — passed a value of `false` to a parameter typed as literal `true` due to `as const`; fixed via the new `EarningsConfig` interface above.

**Verification:**
- Before: `tsc --noEmit` exited 1 with 25 errors across 8 files (silently passing only because vitest's compiler is more lenient than `tsc`).
- After: `tsc --noEmit` exits 0.
- 626 tests pass; coverage 97.19 / 92.47 / 98.41 / 97.19 — unchanged.
- Real-world test: once CI runs on the PR for this phase, the workflow itself proves it can fail a broken commit (the plan's "Tests" section).

**Deferred (tracked in `IMPLEMENTATION_PLAN.md`):**
- **ESLint via `next lint`** — original plan called for "TypeScript + ESLint". Done as a follow-up Phase 9.5 (see below) once Phase 9 had landed cleanly.
- **Coverage artifact upload / Codecov integration** — useful for time-series trends but not necessary for the "block merges below threshold" goal.
- **Nightly JUnit-format run** — was marked optional in the plan; can be added later if we ever care about coverage history beyond what's already in DONE.md / each phase summary.

### Effort: **1 day** (0.5 plan + 0.5 unscheduled TypeScript cleanup that CI itself surfaced).

---

## Phase 9.5 — ESLint setup ✅ DONE

**Why this is its own sub-phase:** the original Phase 9 plan called for "TypeScript + ESLint" but the lurking TypeScript debt Phase 9 had to clear already pushed Phase 9 past its 0.5-day budget. Bundling ESLint on top risked a noisy first-run if the existing code triggered dozens of warnings. Pulled out as a focused follow-up so each PR stays small.

**Shipped:**
- `eslint@^8.57.1` + `eslint-config-next@^14.2.35` added as `devDependencies`. Versions pinned to ESLint 8 / Next 14 — ESLint 9's flat-config requires significant Next.js work that isn't needed here.
- `.eslintrc.json` — extends `next/core-web-vitals` (the official Next.js preset that bundles React Hooks rules + accessibility checks + Core Web Vitals best practices). Per-directory override for `test/**` switches off two rules (`@next/next/no-img-element`, `react/no-unescaped-entities`) that don't apply to test fixtures.
- `.eslintignore` — excludes `node_modules/`, `.next/`, `coverage/`, `prisma/migrations/`, `*.config.js`, `next-env.d.ts`. Keeps lint focused on `src/` + `test/`.
- `package.json` scripts:
  - `lint` → `next lint --max-warnings=0` (any warning fails — same strictness as `tsc --noEmit`).
  - `lint:fix` → `next lint --fix` for auto-fixing whitespace/import-order issues during local dev.
- `.github/workflows/ci.yml` updated: new `Lint (next lint, --max-warnings=0)` step sits between `Typecheck` and `Tests + coverage`. Any of the three failing now blocks the PR.

**Existing-code clean-up needed: just 1 lint error.**
- `src/components/detail-view.tsx:92` — `Couldn't load news` had an unescaped apostrophe that triggered `react/no-unescaped-entities`. Fixed to `Couldn&apos;t load news`.

**Verification:**
- `npm run lint` → `✔ No ESLint warnings or errors`
- `npm run typecheck` → exit 0
- `npm test` → 626 pass; coverage unchanged.

**Deferred:**
- Migration to ESLint v9 + flat config (`eslint.config.js`) — requires `next` and `eslint-config-next` upgrades. Worth doing when we next bump Next.js. Listed in the "Unscheduled" backlog now.
- Stricter rules (e.g. `@typescript-eslint/no-explicit-any`, `import/order`) — would require a dedicated cleanup pass on existing `any` usage in tests. Not worth the disruption today; revisit when test-typing debt is on the agenda.

### Effort: **0.5 day** (faster than expected — only 1 lint error on existing code).

---

## Phase 10 — Scheduler + rate-limit refactor ✅ DONE

**Why this had to happen:** before this phase, `background-fetcher.ts` had **11 ad-hoc `setInterval` calls** with 11 `let xId = null` variables and 11 cleanup blocks in `stopBackgroundFetcher`. Adding a 12th cron required touching all three places. Every Finnhub-backed source module (earnings / news / fundamentals / insiders) had its own copy of `getApiKey()` + `try { fetch } catch { 429 → backoff }` envelope. Every serial-throttled source module (news / fundamentals / insiders / analysts / options) had its own copy of `function sleep(ms)` + per-symbol `for (...) { await fetch; if (429) { backoff }; await sleep(spacing); }`. **5 copies** of sleep, **4 copies** of the Finnhub envelope, **11 copies** of the cron lifecycle — per CLAUDE.md "third copy is a bug" we were way past the line.

**Shipped — three new shared modules:**
- **`src/lib/scheduler.ts`** (97.84% / 88.88% coverage):
  - `registerCron({ name, intervalMs, runOnStart?, run })` — registers a task; idempotent on `name`.
  - `startAll()` / `stopAll()` — armed-once / cleared-all. Safe to call repeatedly.
  - `getStatuses()` — per-task snapshot (lastStartedAt, lastCompletedAt, lastError, isRunning, isArmed) for `/logs` observability.
  - Overlap protection: a tick that lands while the previous run is still in flight is skipped, not double-invoked.
  - Per-task `try/catch` so an unhandled rejection in one cron never crashes the host. Errors land at `<name>:run.unhandled` with the original message preserved on the status record.
- **`src/lib/throttle.ts`** (100% across the board):
  - `sleep(ms)` — fake-timer aware. Single source of truth.
  - `serialThrottle({ items, spacingMs, rateLimitBackoffMs?, onProgress?, progressEveryN?, run })` — owns the serial-iteration pattern. `run` returns a typed `ThrottleStepResult` (`ok | skipped | rate_limited | error`); the loop tallies outcomes, applies spacing, fires progress callbacks, and backs off on rate-limited steps.
  - Per-item exception catching: a throwing `run` is counted as `error`, the loop continues.
- **`src/lib/finnhub.ts`** (100% across the board):
  - `getFinnhubKey()` — single point of `process.env.FINNHUB_API_KEY` access.
  - `finnhubFetch<T>(path, params)` — wraps `fetch` with the no-key / network-error / 429 / non-2xx / JSON-parse error ladder. Returns `{ status: "ok" | "rate_limited" | "no_key" | "error", data?, error? }`.

**Migrated:**
- **`background-fetcher.ts`** — 11 `let xId`, 11 `safeX()` wrappers, 11 `setInterval` calls, and 11 cleanup blocks → one `registerCrons()` function with 11 `registerCron(...)` entries; `startBackgroundFetcher` is now `registerCrons() + startAll()`; `stopBackgroundFetcher` is now `stopAll()`. Net: **~150 lines deleted**, plus the local `function sleep` is gone.
- **`earnings-source.ts`** → uses `finnhubFetch` + `getFinnhubKey`. Hand-rolled envelope (~35 lines) deleted.
- **`news-source.ts`** → uses `finnhubFetch` + `serialThrottle`. Hand-rolled envelope + spacing loop (~70 lines) deleted.
- **`fundamentals-source.ts`** → same pattern. ~50 lines deleted.
- **`insiders-source.ts`** → same pattern. ~50 lines deleted.
- **`analysts-source.ts`** (Yahoo, not Finnhub) → uses `serialThrottle`. Local `function sleep` + spacing loop deleted.
- **`options-source.ts`** (Yahoo) → same. Local `function sleep` + spacing loop deleted.

**Side-fix that came along:**
- `vitest.config.ts` — added `exclude: ["node_modules", ".next", "coverage", ".claude/**"]` so the test runner doesn't pick up Claude Code worktree copies, which were tripling the test count on every run (1914 → 662 after the exclude).

**Tests & coverage:**
- **+36 new tests**: 16 scheduler (registration, start/stop idempotency, runOnStart variants, interval ticking, error catching, lastError reset on next success, overlap protection) + 9 throttle (sleep timing, outcome counts, spacing application, rate-limit backoff timing, progress callback cadence) + 11 finnhub (key handling, URL building, every status path).
- **All 626 existing tests pass without modification** — the refactor is behavior-preserving by construction. New count: **662 tests** across **45 files**.
- Coverage: **97.62 / 92.36 / 97.74 / 97.62** — all thresholds met (≥95 lines/funcs/stmts, ≥90 branches). New modules: scheduler 97.84/88.88, throttle + finnhub both 100/100.

**Deferred:**
- **Concurrency-limit beyond serial-throttle.** When Yahoo (which has no formal rate limit) starts to feel slow, the right next step is `concurrentThrottle({ items, limit, run })`. Not needed today.
- **Smarter rate-limit handling** — exponential backoff after consecutive 429s rather than constant `rateLimitBackoffMs`. Worth doing if we ever hit Finnhub limits in production; current 60s backoff is empirically sufficient.
- **Migration to a real queue library** (Bottleneck / p-queue) — the home-rolled `serialThrottle` is intentionally tiny. Reconsider when we need more than serial + backoff.

### Effort: **2 days** (matched plan estimate).

---

## Phase 11 — Audit log foundation ✅ DONE

**Why this had to happen before Phase 15:** before this phase, `AnalysisCache` held only the *current* analysis per symbol. When a stock moved BUY → HOLD → BUY → STRONG BUY over a week, the upserts overwrote each transition. Phase 15 (backtest) needs the opposite — a permanent, replayable timeline. Phase 18 (decay monitor) needs the same data to compare live vs backtest. Without Phase 11, both downstream phases would be blocked on a missing data source.

**Shipped:**
- **New Prisma model `RecommendationLog`** — id / symbol / timestamp / compositeScore (Int) / recommendation / regime / analysisHash (SHA-1 of canonical key) / signalBreakdown (full-analysis JSON snapshot). Indexed on `(symbol, timestamp)` for the read API and on `timestamp` alone for the prune cron. `npx prisma db push` applied to dev DB.
- **`src/lib/recommendation-log.ts`** (100% line coverage, 94.11% branch). Four exports:
  - `hashRecommendationKey(analysis)` — pure. SHA-1 of `{score, recommendation, regime, sorted catalysts.present, qualityVeto.reason}`. Set semantics for catalysts (sorted before hashing) so list ordering noise can't trigger a write.
  - `maybeLogRecommendation(symbol, analysis)` — fetches the most recent row's hash for this symbol, compares, inserts only when different. Returns `{ wrote: boolean; reason: "first-row" | "changed" | "unchanged" | "error" }`. Best-effort: any DB failure is logged via `audit-log:write.failure` and the function returns `{ wrote: false, reason: "error" }` — the fetcher never crashes from audit-log issues.
  - `getAuditTrail(symbol, { from?, to?, limit? })` — chronologically ascending. Defaults to a 30-day window if no `from` supplied. `limit` is capped at `RECOMMENDATION_LOG_CONFIG.maxReadRows` (5000) regardless of caller input. Returns `signalBreakdown` JSON-parsed back to a structured object; falls back to `{ _raw: ... }` on parse failure (forward-compat shield).
  - `pruneOldRecommendations()` — deletes rows older than 3 years. Returns the deletion count. TODO marker for Phase 16's paper-trade carve-out (don't prune symbols with open paper trades) when `PaperTrade` exists.
- **`RECOMMENDATION_LOG_CONFIG`** in `src/lib/config.ts`: 3-year retention, daily prune cadence, 30-day default read window, 5000-row hard cap on read responses.
- **Wired into `background-fetcher.fetchBatch`** — one `await maybeLogRecommendation(stock.symbol, analysis)` after the existing `analysisCache.upsert`. By design, persistence failures here cannot break the fetcher.
- **Registered the audit-log prune cron via the Phase 10 scheduler** — sits alongside the existing `log-prune`. `audit-log:prune.done` whitelisted in `log-persistence.ts` so successful runs surface on `/logs`.
- **`src/app/api/audit/[symbol]/route.ts`** — JSON-only endpoint. Validates symbol shape (same regex as `/api/news/[symbol]`), uppercases it, accepts optional `from` / `to` / `limit` query params. Rejects malformed dates with HTTP 400 (rather than silent fallback that would mask a typo in a backtest URL). Returns `{ symbol, count, rows }` shape.

**Behavior preserved:** all 32 prior `background-fetcher.test.ts` tests pass without modification — the `maybeLogRecommendation` call is non-blocking in the failure path.

**Snapshot field design (deliberate choice):**
- Full `JSON.stringify(analysis)` minus the `signals[]` array. `signals[]` is UI-derived and reconstructible from the rest of the Analysis; persisting it would inflate row size 2-3× with zero replay value.
- Forward-compatible: when new fields land in `Analysis` (Phase 13 tax info, Phase 14 trade-card extras), they appear in new rows automatically. When Phase 15 reads old rows, missing fields default to `undefined`.

**Tests & coverage:**
- **22 new pure tests** for `recommendation-log.ts` (hash dedup across every key-change vector, hash invariance to catalyst-list ordering and signal-weight noise, maybeLog first-row / unchanged / changed / error paths, signals[] stripping, score-rounding to Int, getAuditTrail mapping + defaults + ISO-string acceptance + max-rows cap + JSON parse-fallback, prune counting + failure handling).
- **9 new API tests** for `/api/audit/[symbol]` (400 on bad symbol, uppercase normalisation, happy-path rows + count, empty-history symbol, query-param forwarding, 400 on bad from/to, negative-limit normalisation, 500 on internal error).
- **3 new `background-fetcher` integration tests**: first-observation writes a row; identical-analysis re-runs write zero rows; `RecommendationLog` write failure doesn't break `AnalysisCache` upsert.
- 696 tests pass total (662 + 34 new). Coverage **97.69 / 92.45 / 97.83 / 97.69** — all thresholds met. `recommendation-log.ts` itself is 100 / 94.11.

**Deferred:**
- **Paper-trade carve-out in the prune cron** — until `PaperTrade` exists (Phase 16), can't filter on it. Marked with a clear `TODO (Phase 16)` comment in `pruneOldRecommendations()`.
- **Audit-trail UI** — JSON endpoint is enough for Phase 15 (backtest) and Phase 18 (decay monitor) to consume. A `/audit/[symbol]` page rendering the timeline as a chart can come later if a human ever wants to eyeball it.
- **Cross-symbol queries** (e.g. "every BUY recommendation made on 2026-02-15") — not needed by Phase 15/18 directly. If a future feature wants it, the existing `(timestamp)` index already supports it.

### Effort: **1.5 days** (matched plan estimate).
