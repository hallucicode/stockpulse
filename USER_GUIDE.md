# StockPulse User Guide

## How the indicators fit together

Each indicator answers a different question:

| Indicator    | Question it answers                              |
|--------------|--------------------------------------------------|
| **RSI**      | Is the stock at a short-term extreme?            |
| **Bollinger**| Is the price unusually far from its average?     |
| **SMA cross**| What's the overall trend direction?              |
| **MACD**     | Is momentum accelerating or fading?              |

The scanner combines all four (plus weekly-dip and volume-spike bonuses) into a single composite score, then turns that score into a recommendation: **STRONG BUY / BUY / HOLD / SELL / STRONG SELL**.

The idea: any single indicator can lie, but when **multiple** independent ones agree, the signal is more trustworthy.

## Stop / Target / R:R on the card

Every stock card shows a row like:

```
Stop: $95.00    Target: $115.00    R:R 3.0×
```

This turns a vague "BUY" into a complete trade plan.

| Term | What it means |
|------|---------------|
| **Stop**   | The price at which you exit if you're wrong. Pre-committed loss limit — usually 5–8% below entry. |
| **Target** | The price at which you exit if you're right. Pre-committed profit-taking level. |
| **R:R**    | Reward-to-Risk ratio. A 3.0× means *for every $1 risked, you're aiming to make $3*. |

**How the app picks the stop:** it computes three candidates — ATR-based (volatility), structural (just below the recent chart low), and an 8% hard cap — and uses the *tightest* one. You'll never risk more than 8% on a single trade.

**How the app picks the target:** always **3× the risk**. If your stop is $5 below entry, the target is $15 above. R:R is therefore 3.0× by design.

**Why this matters:** with a 3:1 R:R, you only need to be right ~33% of the time to break even. With a 1:1 R:R you need 50%. Favourable math turns a mediocre picker into a profitable trader and protects a great picker from ruinous losses.

**How to use it:** when you place the trade in your broker, set:
- **Buy** at the current price
- **Stop-loss order** at the *Stop* price
- **Take-profit order** at the *Target* price

No emotion, no second-guessing. The card has already done the math.

## "📅 EARNINGS IN Nd" badge

When a card shows this amber badge, the company reports earnings in N days. **What this means for you:** earnings days routinely move stocks ±5–15% in a single session — far more than your normal stop-loss can absorb, and the direction is essentially unknowable in advance.

Treat the badge as a deliberate speed bump. The disciplined options are:

1. **Skip the trade.** Default for most retail traders — the technicals will still be there next week with one less unknown.
2. **Half-size it** if you have a real thesis (e.g., the company has beaten estimates several quarters in a row).
3. **Wait for the report**, then trade the aftermath. Often the best entry comes *after* the dust settles.

The app also automatically **downgrades the recommendation by one tier** (STRONG BUY → BUY, BUY → HOLD, etc.) and subtracts 25 points from the score. The badge isn't telling you never to buy — it's telling you *don't sleepwalk into this trade*.
