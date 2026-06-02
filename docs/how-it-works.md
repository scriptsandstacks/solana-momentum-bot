# How Hermes Works — Plain English Guide

This document explains what the bot does, why it does it, and how to read its results. No programming knowledge required.

---

## What is this?

Hermes is an automated trading bot for Solana memecoins. It watches for newly created or newly listed tokens in real time, evaluates whether they show signs of real demand, and — right now — simulates trades without using actual money. This simulation phase is called **paper trading**.

The goal of paper trading is to prove that the strategy makes money before committing real capital. You run it for weeks, look at the results, refine the rules, and only switch to real money once the numbers are consistently good.

---

## What market does it trade?

Hermes trades **Pump.fun tokens on Solana**. Pump.fun is a platform where anyone can create a new token in seconds. The vast majority of tokens created there are worthless and die within minutes. A small fraction, however, go on to move 200%, 500%, or more within their first hour.

The bot's job is to find that small fraction before the move happens.

---

## The two strategies

The bot currently runs two distinct strategies simultaneously. They target different moments in a token's lifecycle.

### Strategy 1: Fresh Launch Momentum

**What it targets:** Tokens that were just created on Pump.fun, typically in the first 5–90 minutes of their existence.

**The edge:** When a new token launches and real demand shows up immediately — rising price, heavy buying, deep enough liquidity to trade — it often continues to run. Most tokens don't show these signals, so strict filtering catches only the real ones.

**How it decides to enter:** It scores every new token on a 0–100 scale based on:

- How much trading liquidity the token has (is there enough to actually buy and sell without crashing the price?)
- How much trading volume has happened in the last 5 minutes (is anyone actually trading this?)
- Whether more people are buying than selling (buy pressure vs sell pressure)
- How old the token is (too new = risky, too old = momentum already gone)
- Whether the price is rising healthily (not falling, not already pumped out)
- Whether a real swap route exists through Jupiter (can we actually execute the trade?)
- Whether the token's creator can still print unlimited new coins (mint authority) — a major red flag
- Whether the creator can freeze holders' tokens (freeze authority) — another red flag

A token needs a score of 75 or higher to be entered. A score of 90+ gets a larger position (1.5× the normal size) because the signal is stronger. A score of 75–79 gets a smaller position (0.75×) because the signal is borderline.

**How it exits:** Two phases:

- *Phase 1 (entry to +30% gain):* Only the stop-loss is active. If the token drops 20% from the entry price, exit immediately. No ceiling on the upside — let the trade breathe.
- *Phase 2 (once the position is up +30%):* A trailing stop activates. If the price then drops 15% from its peak, exit. This captures the bulk of a big move without setting a fixed ceiling. A token that goes +300% will give back at most 15% from its peak before the stop fires — so the realized gain would be at least +255%.

The position is always closed after 60 minutes regardless, even if neither the stop nor the trailing stop fired.

### Strategy 2: Migration Momentum

**What it targets:** Tokens that just "graduated" from Pump.fun to Raydium. This is called a **migration**, and it happens when enough people have bought the token on Pump.fun to fill the bonding curve (~$69,000 raised).

**The edge:** Migration is a structural event, not just hype. The protocol itself executes a large buy order when the migration happens, which seeds liquidity on Raydium. The token has already survived price discovery on Pump.fun, so its liquidity is proven rather than speculative. These migration pumps tend to be sharper and shorter than fresh launch pumps.

**How it decides to enter:** Same general approach as fresh launch, but calibrated for older, more established tokens:

- Liquidity is weighted more heavily (a migrated token with $80K+ liquidity is a strong signal — the bonding curve completion required $69K)
- Age is more forgiving (migrations are typically 30 minutes to 6 hours old by design)
- The entry threshold is slightly lower (score ≥ 70) because the migration itself already filters quality

**How it exits:** Tighter than fresh launch, because migration pumps peak and fade quickly:

- Stop-loss: 18% from entry
- Trailing stop activates at +15% (sooner than fresh launch's +30%)
- Trailing stop width: 12% from peak (tighter)
- Maximum hold: 25 minutes

---

## How does it avoid getting rugged?

"Rug pull" is the term for when a token's creator exits suddenly, crashing the price. The bot screens for several rug signals:

**Mint authority** — If the creator can still mint unlimited new tokens, they can dilute holders at any time. The bot checks the Solana blockchain directly and penalizes any token where mint authority has not been revoked.

**Freeze authority** — If the creator can freeze holder accounts, they can prevent you from selling. Same check, same penalty.

**No sell route** — The bot probes whether the token can actually be sold back to USDC through Jupiter. A token you can buy but cannot sell is a honeypot. Any token with no sell route is rejected outright (−50 points, guaranteeing a score below the entry threshold).

**Realistic fills** — The paper trading simulator applies real transaction fees and price impact to every simulated entry and exit. A token with very thin liquidity will show high slippage costs, which penalizes the score and worsens the simulated P&L. This prevents the simulation from being overly optimistic.

---

## What does the simulation track?

Every token that scores high enough to evaluate is stored in the database, whether it was "traded" or not. For each one, the system tracks:

- The price at the time of scoring
- The highest price reached afterward (MFE — maximum favorable excursion)
- The lowest price reached afterward (MAE — maximum adverse excursion)
- Whether it would have hit the take-profit target
- Whether it would have hit the stop-loss

This is the **counterfactual dataset** — it tells you what would have happened to every token you looked at, including ones you decided not to trade. This is crucial for tuning: if tokens scoring 70–74 are hitting the profit target 60% of the time, the entry threshold is probably set too high.

---

## The reports

### `report`

A snapshot of current state:

- Recent tokens that were evaluated and their scores
- Currently open simulated positions
- Recently closed simulated trades with P&L
- Recent Pump.fun events received

### `stats`

The performance summary for all closed trades. The key numbers:

- **Expectancy** — average P&L per trade. If this is positive, the strategy makes money on average. If negative, it loses.
- **Win rate** — percentage of trades that closed in profit.
- **Profit factor** — gross wins divided by gross losses. Above 1.0 = profitable. Above 2.0 = very strong.
- **By strategy** — separate numbers for Fresh Launch vs Migration so you can see which one is actually carrying the performance.
- **By exit reason** — were wins from trailing stops? Stop losses? Timeouts? This tells you which exit rules are working.
- **By score bucket** — does a score of 90+ actually perform better than 75–79? This validates whether the scoring model is calibrated correctly.

### `strategies`

A one-line summary per strategy: total trades, win rate, total P&L, expectancy, profit factor, average hold time.

### `outcomes`

The counterfactual view — all scored tokens, whether traded or not:

- Average max gain (MFE) and max drawdown (MAE) by score bucket
- What percentage would have hit the profit target vs the stop-loss
- This shows whether the entry threshold is filtering correctly

### `tune`

Takes the outcome data and produces specific recommendations with a confidence level:

- "Raise the entry threshold from 75 to 80 — the 75-79 bucket hits stop-loss 53% of the time vs take-profit 32%. [HIGH confidence]"
- "Your take-profit ceiling of 50% is too low — the best score bucket averages +87% MFE. You're cutting winners short. Raise to 200–300 and rely on the trailing stop. [HIGH confidence]"

This closes the feedback loop: run paper trading for a few weeks, run `tune`, adjust config, repeat.

---

## The improvement cycle

The system is designed around a deliberate feedback loop:

```
Run paper trading for 2–4 weeks
        ↓
Run `stats` and `strategies`
        ↓
Run `outcomes` to see what you missed
        ↓
Run `tune` to get specific recommendations
        ↓
Adjust config.yaml (thresholds, exits, position sizes)
        ↓
Repeat until results are consistently profitable
        ↓
Switch to live trading (not yet implemented)
```

The goal is not to get lucky on a few trades. It is to find a strategy with positive expectancy across enough trades that randomness is not the explanation.

---

## What "paper trading" means for reading results

Every P&L number in the reports is **simulated**. The bot did not actually buy or sell anything. It observed the real market prices and calculated what would have happened if it had.

The simulation is deliberately conservative:

- **Transaction fees** are charged on every entry and exit (30 basis points per leg, configurable)
- **Price impact / slippage** is charged based on real Jupiter quotes at the actual trade size — thin liquidity shows up as real cost
- **Exit prices** are re-quoted from the market at exit time, not just assumed to be the mid price

This makes the paper results a meaningful approximation of live performance, not a frictionless fantasy. The main gap between paper and live results will be **execution latency** — in paper trading, the entry price is the price at the moment of scoring, but in live trading there will be some delay between scoring and execution. Measuring and accounting for that gap is part of the pre-live checklist.

---

## Current limitations to be aware of

- **No live trading yet.** Everything is simulated. The architecture is ready for live trading, but the execution layer (wallet signing, real swap submission) is not built yet.
- **Exits check every 30 seconds** (configurable). A token that spikes and crashes within 30 seconds would be missed. This is acceptable for paper trading but will need real-time triggers for live trading.
- **Volume is a snapshot, not a rate.** The bot sees current 5-minute volume but not whether that volume is accelerating. A token that just went from $500 to $20,000 in the last 5 minutes looks the same as one that's been doing $20,000 every 5 minutes for an hour. Tracking volume acceleration is on the roadmap.
- **Holder concentration not checked.** If a few wallets hold most of the supply, the creator can dump and crash the price. This check requires additional Solana RPC calls and is planned but not yet built.
- **Only Solana.** Base and Ethereum are in the configuration but not active.

---

## Quick reference: how to read a trade in the `report`

```
paper-12 SOLANA BONK strat=freshLaunchMomentum
  reason=trailing_stop source=fresh
  pnl=+$18.43 (+73.7%) closed=2026-06-01T14:22:00Z
```

Reading this:
- Position ID `paper-12`, token symbol `BONK` on Solana
- Handled by the Fresh Launch Momentum strategy
- Exited via the trailing stop (price dropped 15% from its peak)
- Exit price was a fresh market quote (not a stale last-known price)
- Made $18.43 simulated profit, a 73.7% gain on the position
- Closed at 14:22 UTC

```
paper-15 SOLANA PEPE strat=migrationMomentum
  reason=stop_loss source=fresh
  pnl=-$4.50 (-18.0%) closed=2026-06-01T14:35:00Z
```

Reading this:
- Migration strategy trade on PEPE
- Hit the stop-loss (price dropped 18% from entry)
- Lost $4.50 simulated (18% loss on the position)
- This is expected — not every trade wins. The strategy is profitable when winners outweigh losers on average.
