# StockPulse — Implementation Plan

Roadmap for evolving the current technical scanner into a semi-automated trading assistant. Each phase is self-contained, ships independently, and adds testable value.

> **Where's the done work?** Completed phases live in [`DONE.md`](./DONE.md). When a phase here ships, **move its section out of this file into `DONE.md`** so this file stays focused on what's still to do.

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

Phases 0 through 8 have shipped. Their detailed shipped-notes, deviations from the original plan, test counts, and deferral lists live in `DONE.md` to keep this file focused on upcoming work.

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

Each carries a "Deferred" sub-section — those deferrals are either folded into the relevant upcoming phase below or live in the "Unscheduled — open backlog" section at the bottom of this file.

---

# 🚧 Up next — priority order

> **How to use this list:** pick the top non-done item, ship it, move on.
>
> The order below is what *actually* needs doing next — including tech-debt phases that were originally hidden in a "Cross-cutting infrastructure" table at the bottom and were overdue by the time Phase 8 shipped. Bringing them into the main sequence so they don't get forgotten again.
>
> **Renumbering note:** done phases keep their original numbers (referenced in source-code comments). Upcoming phases use fresh sequential numbers in priority order — the original numeric labels (Phase 9 = tax, Phase 11 = backtest, etc.) are noted parenthetically where they help cross-reference older discussion, but the *order* is what governs from here on.

---


## Phase 10 — Scheduler + rate-limit refactor *(tech debt, overdue)*

**Why now:** `background-fetcher.ts` is now 8 `setInterval` calls with 8 IDs to clear in `stopBackgroundFetcher`. Every source module (news, fundamentals, insiders, analysts, options, sector-rotation) has its own copy of `await sleep(1100)` between requests. Per CLAUDE.md "the third copy is a bug" — we're at the fifth.

### Tasks
1. **`src/lib/scheduler.ts`** — one module that owns all crons:
   - `registerCron({ name, intervalMs, run })`
   - `startAll()` / `stopAll()`
   - Single map of `name → { intervalId, lastStart, lastDone }` for observability.
   - Replace the 8 ad-hoc `setInterval` calls in `background-fetcher.ts` with `registerCron(...)` calls.
2. **`src/lib/throttle.ts`** — one shared rate-limit helper:
   - `serialThrottle({ items, spacingMs, run, onProgress })` — serial iteration with per-item spacing, progress callback.
   - `rateLimitAware(fetcher, { backoffMs })` — handle 429s with exponential backoff.
   - Replace each source module's hand-rolled `for (;;) { await fetch; await sleep }` loop with one of these.
3. **Shared per-API key wrapper.** All Finnhub calls go through one function that loads `FINNHUB_API_KEY`, applies the throttle, and returns `{ status: "ok" | "rate_limited" | "no_key" | "error" }`. Today each source re-implements that envelope.
4. Update all existing crons + sources to use the new modules. No behaviour change — refactor only.

### Tests
- Scheduler: registers/unregisters cleanly, doesn't double-start, runs immediately + at interval.
- Throttle: serial iteration, spacing actually applied, 429 backoff fires.
- Per-source tests stay valid (behaviour unchanged).

### Effort: **2 days**.

---

## Phase 11 — Audit log foundation *(tech debt, blocks Phase 15)*

**Why now:** Phase 15 (backtest) needs the ground truth of "what did we recommend, when, with what score, in what regime?". Today, only the *current* analysis is persisted in `AnalysisCache` — historical recommendations are gone. The longer this waits, the less retrospective data we have when Phase 15 finally runs.

### Tasks
1. New Prisma model `RecommendationLog`:
   ```prisma
   model RecommendationLog {
     id             String   @id @default(cuid())
     symbol         String
     timestamp      DateTime @default(now())
     compositeScore Int
     recommendation String
     regime         String?
     /// Snapshot of the per-phase signal adjustments — JSON for forwards-compat.
     signalBreakdown String
     /// Sha-1 of the analysis JSON for cheap "did anything change?" lookups.
     analysisHash   String
     @@index([symbol, timestamp])
     @@index([timestamp])
   }
   ```
2. In `background-fetcher.fetchBatch`, after the analysis is finalised, append one `RecommendationLog` row **only when the recommendation or score has changed** (deduplicate by analysisHash). Cheap; bounded growth.
3. Retention: keep forever for paper trades' parent symbols; rolling 2-year window otherwise.
4. Minimal `/audit/<symbol>` read endpoint (no UI needed yet — just JSON) so Phase 15 backtests can replay.

### Tests
- Insert deduplication: identical analysis ⇒ no new row.
- Score change ⇒ new row.
- Retention pruning preserves rows linked to open paper trades (forward-compat with Phase 16).

### Effort: **1.5 days**.

---

## Phase 12 — FDA / drug-trial catalyst *(was "Phase 7.2")*

**Why now:** Rounds out the Phase 7 catalyst suite. Smaller scope than the other features; good cleanup item before getting into user-facing work.

### Tasks
1. New edge module `src/lib/fda-source.ts` — query openFDA `/drug/drugsfda.json` for recent approvals.
2. **Ticker ↔ drug-applicant matching** (the hard part):
   - Pull `applicant_full_name` from openFDA.
   - Match against `WatchlistStock.name` with a normalised lowercase + strip-suffix comparison (drop "Inc", "Corp", "Pharmaceuticals", etc.).
   - When ambiguous, log + skip (don't false-positively credit a catalyst).
3. New Prisma model `FdaEvent { symbol, eventType, date, description }`.
4. Extend `CatalystType` with `fda_event`; add detection branch in `evaluateCatalysts`.
5. Daily cron via the new Phase 10 scheduler.

### Caveats
- openFDA exposes **approvals** reliably but **upcoming PDUFA dates** sparsely. Scope the catalyst to *recent approval announcements* (last 30 days). Defer "upcoming PDUFA" until a clean data source exists.
- Restrict to Healthcare-sector stocks to limit false positives.

### Tests
- Mock openFDA response, verify catalyst fires only for the right tickers.
- Ambiguous applicant name ⇒ skipped, not crashed.

### Effort: **1.5 days**.

---

## Phase 13 — Tax-aware decisions *(was "Phase 9")*

**Why now:** Largest controllable cost. US short-term capital gains (≤1 year) is up to **37%**; long-term is **15–20%** — a 17–22pp gap that's bigger than most strategies' alpha. Pre-Phase 14 so trade card UI can show holding-period status.

### Tasks
1. New module `src/lib/tax.ts`:
   - **Lot tracking**: FIFO / LIFO / specific-ID per position.
   - **Wash-sale detection**: a sell at a loss disallows the loss for tax purposes if the same security is rebought within 30 days. The system must:
     - Block rebuys within the wash-sale window (configurable: hard block vs. warn).
     - Track and report disallowed losses.
   - **Holding-period awareness**: surface a warning for sells within 30 days of crossing the 1-year threshold (delaying the sale may save 15–20pp).
   - **Tax-loss harvesting**: at year-end, identify open positions at a loss that would be tax-efficient to close.
2. **Account-type config**: per-account flag (`taxable | ira | 401k`). Tax rules apply only to taxable accounts.
3. UI: holding-period progress bar on each open position; year-to-date realized gains/losses tracker.

### Tests
- Wash-sale scenarios (buy → sell loss → rebuy 15 days later).
- Holding-period scenarios (sell at day 360 vs. day 366).

### Effort: **4 days**.

---

## Phase 14 — Trade card UI *(was "Phase 10")*

**Goal:** Replace current cards with the structured recommendation:

```
┌─────────────────────────────────────────────────────┐
│ NVDA — STRONG BUY (score: 62)   Regime: ranging ✓  │
├─────────────────────────────────────────────────────┤
│ Why cheap?    Sector-wide selloff (semis -8% week)  │
│ Catalysts:    📅 Earnings 12d, 👥 Insider cluster, │
│               ⬆ MS upgrade                          │
│ Options:      IV rank 22 (cheap), P/C 0.6           │
│ Diagnosis:    🟢 Technical pullback, no red flags  │
│ Entry / Stop / Target:  $432 / $409 / $503  R:R 3.0 │
│ Size:         47 shares ($20,308)  4.1% portfolio  │
│ Tax:          ⚠ would be short-term (held 184d)    │
│ Confidence:   ★★★★☆                                 │
└─────────────────────────────────────────────────────┘
```

### Tasks
1. New component `src/components/trade-card.tsx`.
2. Replace card rendering in `scanner-view.tsx`.
3. Keep compact list view as a toggle.
4. "Copy trade ticket" / export action.

### Tests
- Snapshot + permutation tests across regime/diagnosis/confidence combos.

### Effort: **3 days**.

---

## Phase 15 — Backtest engine *(was "Phase 11" — make-or-break, THE GATE)*

**This is the gate.** Without realistic execution modeling, the backtest will overstate Sharpe by ~1.5× and you'll size live positions too aggressively. Phase 11 (audit log) must land first so there's a historical record to replay against.

### Tasks
1. New module `src/lib/backtest.ts`:
   - `runBacktest({ symbols, startDate, endDate, strategy }): BacktestResult`
   - Walk-forward simulation — for each historical day, run `analyzeStock` using only data available *at that point* (no lookahead).
2. **Realistic execution model** (the part most retail backtests skip):
   - **Bid-ask spread**: model as 0.05% for liquid large caps, scale up to 1–2% for small caps based on avg dollar volume.
   - **Market impact**: order size > 1% of avg daily volume → assume slippage proportional to participation.
   - **Stop-fill realism**: stops fill at the *worse* of trigger price and next bar's open. Gaps through the stop fill at the gap price.
   - **Gap risk**: model overnight gaps explicitly — if next day opens beyond stop, fill at open, not stop.
   - **Slippage on entries**: market orders get worst price of next bar; limit orders may not fill.
   - **Halt handling**: if halted, no fills until resume.
3. **Metrics**: total return, CAGR, win rate, avg win/loss, profit factor, **Sharpe**, **Sortino**, **max drawdown**, **time underwater**, **per-signal-type attribution**.
4. **Regime-stratified results**: report metrics separately per regime (Phase 6) — strategy may be great in trending markets and a disaster in ranging.
5. CLI: `npm run backtest -- --years 5 --symbol-set sp500`.
6. UI: `/backtest` tab — equity curve, drawdown chart, signal-attribution table.
7. **Use backtest results to re-tune `analysis.ts` weights** — replace intuition with evidence. Re-run after every major addition.

### Caveats
- **Survivorship bias**: Yahoo only serves currently-listed tickers. Document this; consider paid Norgate Data (~$30/mo) once everything else works.
- **Don't overfit**: rule of thumb — degrees of freedom (parameters tuned) ≪ number of independent trades. With 5 years × ~100 trades = 500 trades, can safely tune ~10 parameters; not 50.

### Tests
- Synthetic price data with known outcomes — verify backtest math.
- Lookahead-bias tests — verify we never use day N's close in day N's signal.
- Slippage scenarios — verify gap-through-stop fills correctly.

### Effort: **7–10 days**. Highest value, highest care.

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

### Infrastructure (further out)
- Sentry / Datadog for production error tracking + per-API latency.
- Proper secret management (Doppler / 1Password Connect) before any prod deploy.
- Self-hosting strategy: Docker + docker-compose for paper-trading-mode deployments.

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

**Done so far:** ~37.5 days of build time across Phases 0–9.5. Per-phase effort breakdowns live in [`DONE.md`](./DONE.md).

### 🚧 Remaining (priority order)

| # | Phase | Effort | Cumulative remaining |
|---|---|---|---|
| 10 | Scheduler + rate-limit refactor | 2 d | 2 d |
| 11 | Audit log foundation | 1.5 d | 3.5 d |
| 12 | FDA / drug-trial catalyst | 1.5 d | 5 d |
| 13 | Tax-aware decisions | 4 d | 9 d |
| 14 | Trade card UI | 3 d | 12 d |
| 15 | Backtest engine *(THE GATE)* | 10 d | 22 d |
| 16 | Paper trading | 4 d (+ 12 mo soak) | 26 d |
| 17 | Postgres migration | 1.5 d | 27.5 d |
| 18 | Decay monitoring | 3 d | 30.5 d |
| 19 | Alternative data | 5 d | 35.5 d |
| 20 | Portfolio optimization | 5 d | 40.5 d |
| 21 | Cost-bearing AI *(gated on Phase 15)* | 3–15 d | up to 55.5 d |

**~8 more weeks of focused build time** to reach Phase 16 (paper trading), then the 12-month soak before any real-money decision. Phase 15 (backtest) is the gate that unlocks weight re-tuning, Phase 16 (paper trading), and Phase 21 (LLM enhancements).

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
