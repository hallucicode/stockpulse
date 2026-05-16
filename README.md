# StockPulse — Volatile Stock Trading Assistant

A personal app for catching tops and bottoms on volatile stocks using technical analysis signals. Built with Next.js, Prisma (SQLite), and Yahoo Finance.

## What It Does

1. **Scanner** — Ranks volatile stocks by composite buy/sell score using RSI, Bollinger Bands, MACD, SMA crossovers, volume analysis, and mean-reversion momentum
2. **Buy Signals** — Recommends when to buy based on combined technical indicators (score -100 to +100)
3. **Portfolio Tracker** — Tracks all owned positions with live P&L calculations
4. **Sell Signals** — Recommends when to sell (stop loss at -15%, take profit at +25%, bearish signal detection)
5. **Easy Removal** — One-click to remove/close any position
6. **Push Notifications** — Optional alerts via ntfy.sh (free, no signup)

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up the database
cp .env.example .env
npx prisma db push

# 3. Seed the watchlist with default volatile tickers
npm run db:seed

# 4. Start the dev server
npm run dev
```

Open http://localhost:3000 — that's it. No API keys needed for basic functionality (Yahoo Finance is the default data source and requires no key).

## Architecture

```
stockpulse/
├── prisma/
│   ├── schema.prisma      # Database schema (SQLite)
│   └── seed.ts            # Seeds default watchlist
├── src/
│   ├── app/
│   │   ├── layout.tsx     # Root layout
│   │   ├── page.tsx       # Main app page (client component)
│   │   ├── globals.css    # Tailwind + custom styles
│   │   └── api/
│   │       ├── scanner/route.ts   # GET scanner data
│   │       ├── portfolio/route.ts # GET portfolio
│   │       └── trade/route.ts     # POST buy/sell/remove
│   ├── components/
│   │   ├── scanner-view.tsx   # Stock scanner with filters/sorting
│   │   ├── portfolio-view.tsx # Positions, P&L, sell signals
│   │   ├── detail-view.tsx    # Single stock deep-dive
│   │   ├── sparkline.tsx      # Mini chart component
│   │   └── indicators.tsx     # ScoreGauge, SignalBadge, etc.
│   ├── hooks/
│   │   ├── use-store.ts   # Zustand global state
│   │   └── use-data.ts    # Data fetching + trade actions
│   ├── lib/
│   │   ├── db.ts          # Prisma client singleton
│   │   ├── market-data.ts # Yahoo Finance + Polygon.io fetcher
│   │   ├── analysis.ts    # Technical analysis engine
│   │   ├── actions.ts     # Server actions (all DB mutations)
│   │   ├── notifications.ts # Push notifications via ntfy.sh
│   │   └── cron-alerts.ts # Scheduled alert checker script
│   └── types/
│       └── index.ts       # TypeScript type definitions
├── .env.example
├── package.json
├── tailwind.config.js
└── tsconfig.json
```

## Data Sources (in priority order)

| Source | Key Needed? | Rate Limit | Notes |
|--------|-------------|------------|-------|
| Yahoo Finance | No | ~2000/hr | Default. Works out of the box via `yahoo-finance2` npm |
| Polygon.io | Yes (free tier) | 5/min free | Better real-time data. Set `POLYGON_API_KEY` in .env |
| Alpha Vantage | Yes (free tier) | 25/day free | Fallback only. Set `ALPHA_VANTAGE_KEY` in .env |

## Push Notifications (Optional)

Uses [ntfy.sh](https://ntfy.sh) — completely free, no signup required:

1. Pick a topic name (e.g., `stockpulse-yourname-alerts`)
2. Set `NTFY_TOPIC=stockpulse-yourname-alerts` in `.env`
3. Install the ntfy app on your phone and subscribe to that topic
4. Run the alert checker: `npm run cron:alerts`

For automatic alerts during market hours, add to crontab:
```
*/5 9-16 * * 1-5 cd /path/to/stockpulse && npx tsx src/lib/cron-alerts.ts
```

## Technical Analysis Signals

The composite score (-100 to +100) combines:

| Indicator | Buy Signal | Sell Signal | Weight |
|-----------|-----------|-------------|--------|
| RSI (14) | < 25 oversold | > 75 overbought | ±30 |
| Bollinger Bands | At lower band | At upper band | ±25 |
| Mean Reversion | Weekly dip > 12% | Weekly rally > 15% | ±20 |
| Volume Spike | Capitulation (2x avg + down day) | — | +15 |
| SMA Cross | SMA20 > SMA50, price above | SMA20 < SMA50, price below | ±10 |
| MACD | Positive histogram | Negative histogram | ±10 |

Sell signals for positions:
- **Stop Loss**: Position down > 15% → high urgency
- **Take Profit**: Position up > 25% → medium urgency
- **Bearish Score**: Composite score ≤ -40 → high urgency
- **RSI Overbought**: RSI > 75 with gains → medium urgency

## Claude Code Prompts

Here are useful prompts to extend this app with Claude Code:

### Add a new stock to the watchlist
```
Add RIVN (Rivian Automotive, sector: EV) to the watchlist in the seed file and create a server action to add stocks from the UI
```

### Add historical trade performance chart
```
Add a recharts line chart to the portfolio view showing cumulative P&L over time from closed positions in the trade history
```

### Add price target alerts
```
Add a feature where I can set a target buy price for a watchlist stock, and get notified when the price drops to that level
```

### Improve the MACD calculation
```
The MACD in analysis.ts uses a simplified signal line. Implement proper 9-period EMA of the MACD line by computing MACD values for each historical bar
```

### Add a mobile PWA
```
Convert this to a Progressive Web App with offline support and push notifications using the Web Push API instead of ntfy.sh
```

### Deploy to a VPS
```
Create a Dockerfile and docker-compose.yml for deploying this app. Use SQLite in a Docker volume for persistence. Include the cron job for alerts.
```

## Disclaimer

This is a personal tool for educational purposes. Technical analysis signals are not financial advice. Past performance does not predict future results. Always do your own research before trading.
