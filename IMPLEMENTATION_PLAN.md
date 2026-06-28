# StockPulse — Implementation Plan

Roadmap for evolving the current technical scanner into a semi-automated trading assistant. Each phase is self-contained, ships independently, and adds testable value.

> **Where's the done work?** Completed phases live in [`DONE.md`](./DONE.md). When a phase here ships, **move its section out of this file into `DONE.md`** so this file stays focused on what's still to do.

> **Investor context.** This app is built for a **Netherlands-resident retail investor trading primarily US-listed stocks**. Design defaults assume:
>
> - **Box 3 taxation** (wealth tax on portfolio value), not US capital-gains-on-realised-profit. No holding-period decisions, no wash-sale rule, no FIFO/LIFO lot accounting.
> - **EUR as reporting currency** for tax purposes; USD as the trading currency for most positions. Conversion via ECB daily reference rate.
> - **Yahoo Finance / Finnhub free tier** US-market data coverage. Non-US listings are silently excluded by the Phase 4.5 fundamentals filter.
>
> Whenever a future phase has a tax / regulatory / market-structure dimension, default to NL-resident / US-traded-stocks unless explicitly stated otherwise. Earlier phases (0–12) that assumed US-resident defaults are noted in DONE.md but the assumptions don't bite (technical signals are jurisdiction-neutral).

> **Honest framing.** This is a personal project, not a hedge fund. The realistic goal is **not** "beat the market" — it's:
>
> 1. **Enforce discipline.** Replace gut decisions with mechanical stops, sizing, and entry rules.
> 2. **Reduce blind spots.** Surface earnings, news, insider activity, regime — things a human can't track for 500 stocks.
> 3. **Match the market with smaller drawdowns and fewer emotional mistakes.**
>
> The user already trades profitably by hand. The app's value is making that *consistent and scalable*, not magical.

---

## Guiding principles

### Process
- **One phase = one PR.** Don't queue up huge merges.
- **95% test coverage rule** (see `CLAUDE.md`) applies to every phase.
- **Feature-flag everything user-facing** so we can ship behind toggles and roll back without code changes.
- **Free/cheap data first**, paid APIs only when free tier is exhausted.
- **Paper-trade before trusting any signal.** Phase 12 is the gate before "real money."
- **Default to skepticism.** Every new signal must be validated by backtest before it influences score weights.

### Code quality (long-lived codebase — every phase obeys these)

StockPulse is **expected to live for years and grow continuously**. Code that is "good enough for now" becomes the bug factory of next year. Every phase must respect:

- **Modularity.** Each concern lives in one module with a narrow public API. Cross-module access goes through that API, never through internals. Naming convention:
  - `src/lib/<feature>/` for non-trivial features (multiple files, internal helpers).
  - One default export per module is fine; deep import paths (`../../../lib/foo/internal/util`) are a smell.
- **Extensibility over duplication.** When adding a 2nd similar thing (a 2nd data source, a 2nd signal, a 2nd notification channel), introduce an interface and refactor the 1st to fit it. **The third copy of anything is a bug**, not a feature — refactor before adding it.
- **Stable interfaces, replaceable implementations.** Signals, data sources, notifications, brokers should all sit behind interfaces (`SignalProvider`, `MarketDataSource`, `NotificationChannel`). Today's Yahoo + ntfy.sh implementations should be swappable without touching callers.
- **No fragile code.** Practically:
  - No hidden coupling — modules don't reach into each other's globals or DB tables they don't own.
  - No silent failures — every `catch` either handles the error meaningfully or rethrows with context. **Never `catch (e) {}`.**
  - No hard-coded magic numbers — RSI thresholds, score weights, intervals all live in named, typed config (one source of truth, easy to grep, easy to backtest variations).
  - No `any` in TypeScript except at clearly documented external boundaries.
  - No mutating shared state from multiple call sites — use immutable data structures or explicit owners.
  - No long functions — if a function exceeds ~40 lines or 3 levels of nesting, it splits.
  - No timing-dependent tests — fake timers, deterministic seeds.
  - Failing fast > corrupted state — invalid input throws, doesn't quietly produce a `0`.
- **Single source of truth for shared concepts.** `Analysis`, `Signal`, `TradeCandidate`, `Position` are defined once in `src/types/`. No parallel re-definitions per consumer.
- **Pure core, side effects at edges.** Indicator math, scoring, risk calculation, regime classification are **pure functions** of their inputs. DB writes, API calls, scheduling are isolated to clearly named edge modules (`background-fetcher`, `db`, `notifications`). Pure code is trivial to test and reuse; mixing the two creates the worst kind of fragility.
- **Backwards-compatible data evolution.** Schema changes go through Prisma migrations with a written rationale. Never edit a deployed migration; only add new ones. Old paper-trade records must remain readable forever — they are the ground truth for model decay analysis.
- **Observability is not optional.** Every external API call, every cron run, every signal computation logs structured events. When the system misbehaves at month 9, the logs are the only chance of diagnosing why.
- **Self code review before completion.** After writing or modifying code, before reporting the task done:
  1. Re-read the diff as if reviewing someone else's PR.
  2. Check: is this the simplest design? Does it duplicate anything? Are error paths explicit? Are tests testing behavior, not implementation?
  3. Look for fragility tells: silent catches, magic numbers, hidden coupling, untested branches.
  4. Fix what's found before committing.

These rules apply to **every phase, including small fixes.** Cutting corners in a "quick fix" compounds; the codebase is the test of whether discipline held.

---

## ✅ Done — see [`DONE.md`](./DONE.md)

Phases 0 through 13 have shipped (plus the 9.5 / 11.x sub-phases for ESLint, vitest config, FDA matching, and audit-log schema version). Their detailed shipped-notes, deviations from the original plan, test counts, and deferral lists live in `DONE.md` to keep this file focused on upcoming work.

**Quick index of what's done:**
- Phase 0 — Data quality firewall
- Phase 1 — Stops & position sizing
- Phase 2 — Quality gate v1 *(replaced by 2.5)*
- Phase 2.5 — Quality gate (extended red flags)
- Phase 3 — Earnings calendar
- Phase 4 — News + diagnosis pipeline
- Phase 4.5 — Fundamentals filter
- Phase 5 — Insider buying & analyst rating changes
- Phase 6 — Market regime detection
- Phase 7 — Catalyst scoring
- Phase 7.1 — Sector rotation catalyst
- Phase 8 — Options market signals
- Phase 9 — Continuous integration
- Phase 9.5 — ESLint setup
- Phase 10 — Scheduler + rate-limit refactor
- Phase 11 — Audit log foundation
- Phase 12 — FDA / drug-trial catalyst
- Phase 13 — Box 3 helper *(rescoped from US-tax-aware)*
- Phase 14 — Trade card UI
- Phase 15a — Backtest: historical data + viewer
- Phase 15b — Backtest: walk-forward simulator + minimal UI

Each carries a "Deferred" sub-section — those deferrals are either folded into the relevant upcoming phase below or live in the "Unscheduled — open backlog" section at the bottom of this file.

---

# 🚧 Up next — priority order

> **How to use this list:** pick the top non-done item, ship it, move on.
>
> The order below is what *actually* needs doing next — including tech-debt phases that were originally hidden in a "Cross-cutting infrastructure" table at the bottom and were overdue by the time Phase 8 shipped. Bringing them into the main sequence so they don't get forgotten again.
>
> **Renumbering note:** done phases keep their original numbers (referenced in source-code comments). Upcoming phases use fresh sequential numbers in priority order — the original numeric labels (Phase 9 = tax, Phase 11 = backtest, etc.) are noted parenthetically where they help cross-reference older discussion, but the *order* is what governs from here on.

---





## Phase 15 — Backtest engine *(was "Phase 11" — make-or-break, THE GATE)*

**This is the gate.** Without realistic execution modeling, the backtest will overstate Sharpe by ~1.5× and Phase 16 (paper trading) is unjustified. Weight-tuning before this lands is guesswork.

### Scope decisions (locked)

| Decision | Choice |
|---|---|
| **PR shape** | Split into **four sub-phases (15a → 15d), each its own PR**. Every sub-phase ships UI you can see and use — no CLI-only checkpoints. |
| **Bar storage** | New `HistoricalBar` Prisma table, indexed `(symbol, date)`. ~125k rows at watchlist × 5y. SQLite handles it; migrates cleanly to Postgres in Phase 17. |
| **Universe** | Current watchlist only (~50–100 names). Same universe as live scanner = backtest measures *our actual strategy on our actual stocks*. |
| **Survivorship** | Document bias in report + UI, ship anyway. Paid corrected data (Norgate ~$30/mo) lives in Unscheduled backlog. |
| **Report format** | Each run produces JSON (for UI + audit) and a markdown summary (for terminal viewing + GitHub PR comments). |
| **Weight re-tuning** | **NOT in Phase 15.** Lives in the Unscheduled backlog as "Backtest weight re-tuning (grid search)". Building optimisation in parallel with the engine mixes "does the backtest work" with "is the strategy optimal" — diagnosis becomes painful. |

### Why split? Why UI from day one?

Splitting: each sub-phase is shippable in 1–3 days as a coherent PR (vs a 10-day mega-PR). If the strategy turns out to be unworkable — a real possibility, that's *why* we backtest — we can stop after 15a–15b and skip the polish work. Failures isolate: a bug in walk-forward simulation can't be confused with a bug in metrics calculation if they shipped separately.

UI from day one: you see historical-data quality (15a) before the backtest depends on it; you see walk-forward intermediate state (15b) while it runs, not after it finishes; metrics and charts (15c–d) become incremental enhancements on a UI you've already used.

---

### Phase 15c — Metrics + per-regime + per-signal attribution

**Goal:** turn raw `BacktestTrade[]` into the professional metrics that tell you whether the strategy is worth running.

**Ships:**
- **`src/lib/backtest-metrics.ts`** (pure):
  - `computeMetrics(trades, equityCurve)` → returns:
    - **Returns**: total return %, CAGR, avg win/loss.
    - **Risk-adjusted**: Sharpe (annualised), Sortino (downside-only), Calmar.
    - **Drawdown**: max DD %, longest DD duration, time underwater fraction.
    - **Trade quality**: win rate, profit factor, expectancy per trade.
  - `computePerRegimeMetrics(trades)` — same metrics grouped by Phase 6 regime active at entry. Catches "strategy great in trending_up, disaster in trending_down".
  - `computePerSignalAttribution(trades)` — per signal type (RSI oversold, MACD cross, insider cluster, etc.), aggregate P&L of trades where that signal was active. Catches "score is positive overall because catalyst weight is doing all the work; RSI signals are net-negative".
- **`runBacktest` pipeline updated** to embed metrics + per-regime + per-signal in the `BacktestResult`.
- **Markdown report generator** — `formatReport(result): string` saves to `/data/backtest-reports/<runId>.md`. Useful for sharing in PR descriptions.
- **UI: `/backtest` page extended** — three new tabs after the trade list: "Metrics", "By Regime", "By Signal". Tight metrics tables; sortable.

**Tests:** each metric vs hand-computed reference, per-regime grouping correctness, per-signal attribution sums, markdown snapshot, UI tab switching + sorting.

**Effort: ~1.5 days.**

---

### Phase 15d — Equity curve + drawdown charts + visual polish

**Goal:** make `/backtest` a tab you actually want to look at. Charts + storytelling.

**Ships:**
- **`<EquityCurve>` chart** — SVG line chart of portfolio value over time, with SPY total-return benchmark overlay. Drawn from scratch (no chart library) to keep bundle small — Phase 14 already proved we can do CSS-driven dataviz cleanly. ~150 lines.
- **`<DrawdownChart>`** — area chart below equity curve, % below all-time-high at each point. Aligned x-axis.
- **`<TradeListTable>` enhancements** — sortable columns, filter chips by signal type and regime, click-trade-to-expand showing entry/exit detail and a holding-period sparkline.
- **Survivorship warning banner** — prominent banner on `/backtest` explaining the bias and what it means for the numbers.
- **`/backtest/runs` page** — every stored `BacktestRun` with date / params / total-return / Sharpe. Clickable to re-open. Lets you compare strategy revisions over time.

**Tests:** chart components render expected points/lines, survivorship banner always present, runs list renders + click navigates.

**Effort: ~1.5 days.**

---

### Caveats (apply to the whole phase)

- **Survivorship bias**: Yahoo serves only currently-listed tickers. Documented in report + UI. Real fix lives in backlog.
- **Don't overfit**: rule of thumb — degrees of freedom (parameters tuned) ≪ number of independent trades. With 5 years × ~100 trades = 500 trades, can safely tune ~10 parameters; not 50. This applies *especially* once weight re-tuning lands as the next backlog item.

### Effort (remaining)

| Sub-phase | Effort | Cumulative |
|---|---|---|
| 15c — Metrics + attribution | 1.5 d | 1.5 d |
| 15d — Charts + polish | 1.5 d | 3 d |

**~3 days remaining.** 15a + 15b shipped (see [`DONE.md`](./DONE.md)).

---

## Phase 16 — Paper-trading mode *(was "Phase 12")*

**Goal:** Run live without real money for **at least 12 months** (long enough to cover one regime change), prove it works on unseen data, then graduate.

### Tasks
1. Prisma:
   ```prisma
   model PaperTrade {
     id             String   @id
     symbol         String
     entryDate      DateTime
     entryPrice     Float
     stop           Float
     target         Float
     shares         Int
     exitDate       DateTime?
     exitPrice      Float?
     exitReason     String?  // stop | target | time_stop | manual
     pnl            Float?
     signalSnapshot String   // JSON of full Analysis at entry
     regime         String   // regime at entry
   }
   ```
2. Background job: every BUY recommendation auto-opens a paper trade (subject to portfolio circuit breakers from Phase 2).
3. Daily job: check existing paper trades against current price; close on stop/target/time stop.
4. Apply realistic execution from Phase 11 to paper fills (don't fantasy-fill at midpoint).
5. UI `/paper` tab: open positions, closed trades, equity curve, P&L by signal type, per-regime stats.
6. Compare paper outcomes against backtest predictions weekly — divergence > 2σ = real-world signal of overfit.
7. **Gating rule** for going live: 12 months paper-trading, results within 20% of backtest expectations, max drawdown ≤ backtest max drawdown × 1.3, at least one regime change covered.

### Tests
- Mock time progression to simulate trade lifecycle.
- Edge: stop and target both touched same day — use intraday OHLC to resolve realistically (whichever was hit first).

### Effort: **4 days** + **12-month soak time**.

---

## Phase 16.1 — Paper-trade carve-out for audit-log prune

**Why this is its own sub-phase:** Phase 11 left a `TODO (Phase 16)` marker in `pruneOldRecommendations()` — the prune cron currently deletes every `RecommendationLog` row older than 3 years, with no awareness of paper trades. Once Phase 16 ships the `PaperTrade` model, we **must not** prune a row whose symbol still has an open paper trade; that row is part of the audit chain proving the recommendation that opened the trade.

Pulled out as a sub-phase rather than folded into Phase 16 itself because Phase 16 is already a substantial feature + 12-month soak commitment; bundling unrelated audit-log surgery would balloon the PR scope.

### Tasks
1. Update `pruneOldRecommendations()` in `src/lib/recommendation-log.ts` to additionally exclude symbols that appear in any `PaperTrade` row with `status = "open"`:
   ```ts
   const openSymbols = (await db.paperTrade.findMany({
     where: { status: "open" },
     select: { symbol: true },
     distinct: ["symbol"],
   })).map((r) => r.symbol);
   await db.recommendationLog.deleteMany({
     where: {
       timestamp: { lt: cutoff },
       symbol: { notIn: openSymbols },
     },
   });
   ```
2. Update the existing test to assert that rows for a symbol with an open paper trade survive the prune even when past the cutoff.
3. Remove the `TODO (Phase 16)` comment from `pruneOldRecommendations()`.

### Tests
- Single row past cutoff, no paper trades → deleted.
- Single row past cutoff, symbol has open paper trade → preserved.
- Single row past cutoff, symbol has only *closed* paper trades → still deleted (audit context for the closed trade has already served its purpose).

### Effort: **0.5 day**. Tiny scope; should land in the same week as Phase 16 merges.

---

## Phase 17 — Postgres migration *(tech debt, do once growth bites)*

**Why here in the order:** by the time paper trading has been running for a few months, `OptionsSnapshot` is the size of `LogEntry` × 600 stocks × N days. SQLite is fine until something gets slow; this phase is the planned moment to switch before it does.

### Tasks
1. Add a Postgres dev-compose target (or Supabase/Neon free tier).
2. Update `prisma/schema.prisma` provider; add a `DATABASE_URL_POSTGRES` env. Keep the SQLite path workable for local dev.
3. Migrate the `LogEntry`, `OptionsSnapshot`, `SectorSnapshot`, `RecommendationLog` tables — those are the ones SQLite will hate first.
4. Add **proper migrations** (`prisma migrate dev` instead of `db push`) — once on Postgres we want a migration history.
5. Verify all existing tests still pass against both providers.

### Tests
- Run the suite against both SQLite and Postgres (CI matrix).

### Effort: **1.5 days** + a careful read of any raw-SQL paths (there are none today).

---

## Phase 18 — Model decay monitoring *(was "Phase 13", continuous)*

**Goal:** A strategy that worked in 2020 may not in 2025. Without active monitoring, you'll keep trusting a broken system because you remember the great backtest.

### Tasks
1. New module `src/lib/decay-monitor.ts`:
   - **Sliding-window stats**: last 60 trades — Sharpe, win rate, avg win/loss.
   - **Vs.-backtest divergence**: live Sharpe / live drawdown vs. backtest expectation.
   - **Alert thresholds**:
     - Live Sharpe < 0.5 × backtest Sharpe → yellow alert.
     - Live drawdown > 1.5 × backtest max → red alert, **auto-degrade to paper-only mode**.
2. Weekly summary email/notification with regime, performance vs. backtest, top winners/losers.
3. Quarterly forced re-evaluation prompt: re-run backtest with last 3 months added; do weights still hold?

### Effort: **3 days**.

---

## Phase 19 — Alternative data *(was "Phase 14", cheap edge)*

**Goal:** Add the no-cost / low-cost data sources that aren't priced into technicals.

### Tasks
1. **Reddit / StockTwits sentiment** (free APIs): track mention volume + sentiment per ticker. Spike detection.
2. **Google Trends** (free): retail interest spike → often near tops, sometimes near bottoms.
3. **Job postings** (LinkedIn scraping or Greenhouse public boards): hiring acceleration/freeze precedes earnings surprises.
4. **App Store / Play Store rankings** for consumer SaaS / app-driven names.

Each becomes a small additive signal (+5 / −5) once validated by backtest.

### Effort: **5 days**, can be parallelized as separate sub-modules.

---

## Phase 20 — Portfolio optimization *(was "Phase 15")*

**Goal:** Pick the best *combination* of trades, not just the best individual trades.

### Tasks
1. **Mean-variance optimizer**: given N candidates, choose weights that maximize Sharpe under constraints (sector cap, single-name cap, total leverage).
2. **Hedging layer**: when net long > X%, suggest cheap SPY puts or VIX call ladders as portfolio insurance.
3. **Factor exposure tracker**: decompose portfolio into factors (size, value, momentum, quality, low-vol) — alert if "diversified" portfolio is actually one big factor bet.
4. **Cash allocation rule**: when fewer than N high-confidence signals, hold cash. When regime is `high_vol_crisis`, raise cash automatically.

### Effort: **5 days**.

---

## Phase 21 — Cost-bearing AI enhancements *(was "Phase 16", gated)*

**Goal:** Items that demonstrably improve signal quality but require a paid API key (Anthropic / FinBERT-on-HuggingFace) and recurring per-call cost. Deferred to the very end of the plan because they should only ship after Phase 15 (backtest) shows that the cheaper alternatives (regex classifier, categorical signal) are leaving meaningful alpha on the table.

### Items

1. **Claude Haiku LLM fallback for `unknown` diagnoses**
   - For every news item the regex classifier in Phase 4 tags as `unknown`, fall back to Claude Haiku 4.x with a small structured prompt: *"Given these headlines, classify the move into {category list}. Return JSON."*
   - Use **prompt caching** so the system prompt + category schema only count once per call.
   - Cap concurrency to keep cost predictable.
   - Cache the LLM result with the same SHA-1-of-headlines key already used by `DiagnosisCache` — most stocks won't change their headline set between calls, so cost is bounded.
   - Estimated cost: ~$0.01–0.05/day at our universe size. Real but not free.

2. **Per-article sentiment scoring**
   - FinBERT (HuggingFace inference API) or another LLM call to produce a `[-1, 1]` sentiment score per headline.
   - Aggregate to a per-symbol "news sentiment" feature that the scoring system can use as a tiebreaker between similar-score names.
   - Cost is per-headline — at 30 headlines × 600 stocks × daily refresh = 18k inferences/day. FinBERT free tier won't cover this; needs a paid plan or local model serving.

3. **Earnings call transcript summarisation**
   - When earnings drop (Phase 3 detects), pull the call transcript (Finnhub or paid provider), run an LLM summary, surface the 3-bullet "what management said" on the Phase 10 trade card.
   - Highest-value-per-dollar AI use in the system, but expensive (long input prompts).

### Gates before shipping

Per the "default to skepticism" principle in the Guiding Principles section:

- Phase 15 backtest must show that the regex classifier's `unknown` category systematically underperforms — otherwise we're paying for accuracy nobody needs.
- Each AI feature flag gates on an env var (`ENABLE_LLM_DIAGNOSIS`, `ENABLE_SENTIMENT`, etc.). Default off. Costs accrue only when explicitly turned on.
- Add a `/logs` line for every paid API call with cost estimate so spend is observable.

### Effort: **3–5 days per item**, plus monitoring.

---

---

# 📋 Unscheduled — open backlog

> Items that have been deferred without a real slot. **Honest status:** they may never ship unless explicitly promoted. Listed so they're not forgotten — pull from this list into a numbered phase whenever you decide one matters enough.

### Charts & visualisations (UI nice-to-haves)
- `/regime` page charting regime over time (schema already preserves history).
- `/sectors` page charting per-sector rotation (schema preserves history).

### Notifications
- System-wide push notification when regime flips.
- Per-sector notification when a sector flips to `turning_up` (lists the watchlist stocks now in catalyst windows).
- IV-rank-crossed-90 notification per symbol.

### Watchlist hygiene
- Auto-removal of chronically-failing tickers (Phase 0 deferral) — quarantined stocks that fail data-quality for N consecutive cycles get dropped from the watchlist.
- Soft-delete vs hard-delete: keep the row but mark `inactive`, so historical recommendations stay readable.

### Score refinement (will be revisited after Phase 15 backtest)
- Major-firm-vs-other weighting for analyst actions (Goldman / MS heavier than regional).
- Insider *sells* as a signal (currently only cluster buys nudge the score).
- Soft fundamentals warnings (P/E > 100, recent reverse split) — gentler than the hard veto.
- Sector-relative valuation thresholds (P/E vs sector median).
- `unusual_call_buying` as a Phase 7 catalyst type (currently only nudges score).
- IV term-structure (front vs 60-day) — needs multi-expiry pulls per symbol.

### Data sources that require new integrations
- Cross-source price verification (Stooq / Alpha Vantage) for moves > 10% (Phase 0 deferral).
- Corporate-action detection from `adjclose` to distinguish splits from suspicious gaps (Phase 0 deferral).
- Investor-day / conference detection — **no free data source known**. Stays deferred indefinitely.
- Earnings call transcript ingest (raw text, not summarisation — that's Phase 21).
- Block-trade detection in options (Phase 8 deferral) — needs paid Polygon / CBOE data.
- Greeks beyond IV (delta / gamma / theta / vega) — compute when Phase 14 trade card needs them.

### Box 3 helper (Phase 13 follow-ups)
- **Stale-rates warning banner.** `BOX3_CONFIG` (heffingsvrij, deemed-return rate, tax rate) is pinned to a single tax year and needs a manual yearly bump. If the config is older than ~18 months, show a banner on the Box 3 panel ("Rates last updated YYYY-MM — please verify against current Belastingdienst figures"). Cheap to build (`BOX3_CONFIG.ratesLastUpdated` constant + a date check in `Box3Panel`); meaningful safety net if a yearly update gets missed. Promote to a phase only if a yearly bump actually gets forgotten — otherwise low priority.
- Partner-pooling (heffingsvrij doubles for fiscal partners).
- Multi-currency beyond USD/EUR (GBP/CHF positions if the universe ever broadens).
- Auto-snapshot cron on Jan 1 (currently a manual button click).
- `/box3` history page surfacing the `Box3Snapshot` rows (API exists; no UI yet).
- Secondary FX source behind `getLatestUsdEurRate` (ECB direct / exchangerate.host) for Frankfurter outages.

### Backtest engine (Phase 15 follow-ups)
- **Backtest weight re-tuning (grid search)** — once Phase 15d ships and we know the baseline strategy's metrics, grid-search over `SCORING_WEIGHTS` to find the parameter set that maximises Sharpe on held-out data. Strict overfitting discipline (≤10 free parameters per 500 trades). ~3 days. Held out of Phase 15 deliberately so we can distinguish "backtest engine bugs" from "strategy is suboptimal".
- **Survivorship-corrected historical data** — evaluate Norgate Data (~$30/mo) or similar paid sources. Build out only if v1 backtest results justify the spend.
- **Multi-strategy abstraction** — abstract `runBacktest` over a `Strategy` interface once there's a second strategy to compare. Premature now.
- **S&P 500 universe support for backtest** — `--symbol-set sp500` for sanity-checking generalisation beyond our watchlist.
- **Halt detection in backtest execution model** — Yahoo doesn't tag halts cleanly; needs a paid intraday data source. Documented limitation of v1.
- **Splits / dividends corporate-action handling** — Phase 15a captures `adjClose` but doesn't apply it during simulation; v1 trades raw close prices. Inaccurate for stocks with splits in the window.

### Infrastructure (further out)
- Sentry / Datadog for production error tracking + per-API latency.
- Proper secret management (Doppler / 1Password Connect) before any prod deploy.
- Self-hosting strategy: Docker + docker-compose for paper-trading-mode deployments.
- **Auth on the public API surface before any non-localhost deploy.** Today every `/api/*` route is open — fine for localhost dev, but the moment the app is reachable from outside `127.0.0.1` (Vercel preview, phone-on-LAN, a Tailscale tap, anything) these endpoints leak the system's full output. Most-sensitive endpoints in priority order: `/api/audit/[symbol]` (discloses every recommendation ever made — the highest-value scrape target), `/api/scanner` (live signals), `/api/portfolio` + `/api/trade` (positions + ability to mutate). Minimum bar: a shared-secret `Authorization` header check applied via Next.js middleware. Proper bar: a single-user session cookie (NextAuth or similar). Block on this *before* the first non-localhost deploy, not after.

---

## Risks & open questions

- **API costs scale with universe size.** 500 stocks × hourly news pulls = real money. Decide: narrow to 100–200 watchlist stocks, or pay for higher tiers?
- **Survivorship bias in backtest.** Yahoo serves only current tickers. Document the bias for v1; revisit with paid data after Phase 15.
- **Diagnosis accuracy.** LLM news classification will misclassify ~10–15% of edge cases. Acceptable for screener; not for execution.
- **Overfitting risk.** Each new signal adds parameters. Discipline: every weight change must be backtested *and* validated on held-out data.
- **Regulatory line.** Screener-only is fine. The moment we automate **execution** (place real orders), we may need licensing depending on jurisdiction. Stay screener+paper unless we want that headache.
- **Personal bandwidth.** Solo project. By month 7, when the strategy has a bad quarter, will you trust it or override it? Build the audit log (Phase 11) + decay monitor (Phase 18) so the answer is data, not gut.

---

## Total timeline

**Done so far:** ~51 days of build time across Phases 0–14 + 15a + 15b. Per-phase effort breakdowns live in [`DONE.md`](./DONE.md).

### 🚧 Remaining (priority order)

| # | Phase | Effort | Cumulative remaining |
|---|---|---|---|
| 15c | Backtest — metrics + attribution | 1.5 d | 1.5 d |
| 15d | Backtest — charts + polish *(GATE clears here)* | 1.5 d | 3 d |
| 16 | Paper trading | 4 d (+ 12 mo soak) | 7 d |
| 16.1 | Paper-trade carve-out for audit-log prune | 0.5 d | 7.5 d |
| 17 | Postgres migration | 1.5 d | 9 d |
| 18 | Decay monitoring | 3 d | 12 d |
| 19 | Alternative data | 5 d | 17 d |
| 20 | Portfolio optimization | 5 d | 22 d |
| 21 | Cost-bearing AI *(gated on 15d)* | 3–15 d | up to 37 d |

**~3 days to reach Phase 16** (paper trading), then **~4–5 weeks** of remaining build before the 12-month soak begins. Phase 15 (split 15a–d; 15a + 15b done) is the gate that unlocks weight re-tuning, Phase 16, and Phase 21 (LLM enhancements).

### What's "left behind" at the bottom — and why that's intentional now

Phases 9–11 are tech-debt items that were originally hidden in a "Cross-cutting infrastructure" table at the bottom of this file. They got buried, weren't picked up at their planned slots (Phase 1 / 3 / 5 / 7 / 11), and by Phase 8 it was painfully obvious: `background-fetcher.ts` had eight `setInterval` calls, five copies of `await sleep(1100)`, zero CI, zero audit log. Promoting them into the main priority queue here means they actually get done — and crucially, **Phase 11 (audit log) ships before Phase 15 (backtest)**, which depends on it.

---

## Realistic expectations

- **You're already profitable manually.** That means your judgment has a real edge. The app's job is not to replace that judgment, but to:
  - Stop you from making the predictable retail mistakes (no stops, oversized positions, panic exits, FOMO entries).
  - Surface things you can't possibly track manually for 500 stocks (earnings dates, insider clusters, regime shifts).
  - Document outcomes so you can tell which of *your* habits actually make money vs. which feel good.
- **The realistic v1 win**: same returns as your manual trading, but **half the drawdown and 10× the universe coverage** — because the app enforces discipline you can't enforce by willpower alone.
- **Beating the market is a stretch goal, not the thesis.** Most quant funds with PhD teams can't do it consistently. Plan for "match SPY with smaller drawdowns + zero emotional decisions" and you'll have built something genuinely useful.
- **Small apps absolutely have a place.** You're not competing with Citadel — you're competing with *your past self trading without a system*. That's a winnable fight.
