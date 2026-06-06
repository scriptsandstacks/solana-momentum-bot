# How Solana Trade Engine Works — Plain English Guide

This document explains what the bot does, why it does it, and how to read its results. No programming knowledge required.

---

## What is this?

Solana Trade Engine is an automated trading bot for Solana memecoins. It watches for newly created or newly listed tokens in real time, evaluates whether they show signs of real demand, and executes real swaps on-chain using Jupiter. It also supports a **paper trading** mode where it simulates trades without using real money.

Paper mode is an optional calibration loop. The owner can switch between paper and live mode through configuration when they are ready; the system does not require a fixed number of paper cycles before live trading.

---

## What market does it trade?

Solana Trade Engine trades **Pump.fun tokens on Solana**. Pump.fun is a platform where anyone can create a new token in seconds. The vast majority of tokens created there are worthless and die within minutes. A small fraction, however, go on to move 200%, 500%, or more within their first hour.

The bot's job is to find that small fraction before the move happens.

---

## The two strategies

The bot runs two distinct strategies simultaneously. They target different moments in a token's lifecycle.

### Strategy 1: Fresh Launch Momentum

**What it targets:** Tokens that were just created on Pump.fun, typically in the first 5–90 minutes of their existence.

**The edge:** When a new token launches and real demand shows up immediately — rising price, heavy buying, deep enough liquidity to trade — it often continues to run. Most tokens don't show these signals, so strict filtering catches only the real ones.

**How it decides to enter:** Every new token is scored on a 0–100 scale based on:

- How much trading liquidity the token has
- How much trading volume has happened in the last 5 minutes
- Whether more people are buying than selling
- How old the token is (too new = risky, too old = momentum already gone)
- Whether the price is rising healthily
- Whether a real swap route exists through Jupiter (can we execute the trade?)
- Whether a sell route exists (can we exit? A token you can buy but cannot sell is a honeypot)
- Whether the creator can still print unlimited new tokens (mint authority) — a major red flag
- Whether the creator can freeze holder accounts (freeze authority) — another red flag
- Whether a few large wallets own most of the supply (top-5 holder concentration)
- Whether trading volume is accelerating or decelerating right now

A token needs a score of 75 or higher to be entered. A score of 90+ gets a larger position (1.5× normal size). A score of 75–79 gets a smaller position (0.75×).

**How it exits:** Two phases:

- *Phase 1 (entry to +30% gain):* Only the stop-loss is active. If the token drops 20% from entry, exit immediately. No ceiling — let the trade breathe.
- *Phase 2 (once the position is up +30%):* A trailing stop activates. If the price then drops 15% from its peak, exit. This captures the bulk of a big move without setting a fixed ceiling.

The position always closes after 60 minutes regardless.

### Strategy 2: Migration Momentum

**What it targets:** Tokens that just "graduated" from Pump.fun to Raydium. This happens when enough people have bought the token on Pump.fun to fill the bonding curve (~$69,000 raised).

**The edge:** Migration is a structural event. The protocol itself executes a large buy order that seeds Raydium liquidity. The token has already survived price discovery on Pump.fun, so its demand is proven. Migration pumps are typically sharper and shorter than fresh-launch pumps.

**How it exits:** Tighter than fresh launch — migration pumps peak and fade quickly:
- Stop-loss: 18% from entry
- Trailing stop activates at +15% (sooner than fresh launch's +30%)
- Trailing stop width: 12% from peak
- Maximum hold: 25 minutes

---

## How does it avoid getting rugged?

**Mint authority** — If the creator can still mint unlimited new tokens, they can dilute holders at any time. The bot checks the Solana blockchain directly and penalises any token where mint authority has not been revoked.

**Freeze authority** — If the creator can freeze holder accounts, they can prevent selling. Same check, same penalty.

**No sell route** — The bot probes whether the token can actually be sold back to USDC through Jupiter. A token you can buy but cannot sell is a honeypot. Any token with no sell route receives a −50 point penalty that guarantees rejection.

**Holder concentration** — If the top 5 wallets hold 80% or more of the supply, a few holders can dump and crash the price. The bot penalises high concentration.

**Volume acceleration** — The bot tracks whether volume is increasing or decreasing in the current window. A token with decelerating volume gets a penalty; one with a strong acceleration spike gets a bonus. This prevents entering tokens where the momentum has already passed.

**Realistic fills** — The paper trading simulator applies real transaction fees and price impact on every entry and exit, so paper P&L is a meaningful approximation rather than frictionless fantasy.

---

## How live trading works

When `mode: live` is set in the config, the bot executes real on-chain swaps:

1. Finds a qualifying token
2. Gets a fresh quote from Jupiter at the exact position size
3. Builds a swap transaction
4. Signs it with the wallet keypair
5. Submits to the Solana network
6. Waits for the configured commitment level (`confirmed` or `finalized`)
7. Reads the confirmed transaction's wallet balance changes
8. Records the actual fill quantity, price, and transaction signature

Exit trades follow the same path in reverse (token → USDC). Every trade's transaction signature is stored in SQLite so it can be verified on-chain.

The live cash figure values the wallet's supported funding assets: SOL, USDC,
and USDT. Before a buy is submitted, the bot re-quotes the actual position size
across the inputs the wallet can fund and selects the route that returns the
most tokens, while rejecting quotes above the configured price-impact cap. An
unfunded discovery-time route therefore does not prevent a funded alternative
from trading, and a thin actual-size route cannot slip through just because the
small discovery probe looked acceptable.

At startup in live mode, the bot cross-checks the wallet's on-chain token
balances against its SQLite records. Any discrepancy is logged immediately, and
the `recover-positions` command can resolve it. A tracked position with no
meaningful matching wallet balance is quarantined: the bot will not submit
repeated exit transactions or open new positions until the discrepancy is
resolved.

When recovering an untracked token holding, the bot searches recent wallet
transactions for the original buy. Stablecoin-funded buys can recover the exact
USD entry basis and transaction signature. If the transaction history is
unavailable, the recovery plan clearly labels the current-price entry basis as
approximate. SOL-funded buys use the recovered SOL amount and current SOL/USD,
and are also labeled approximate because historical SOL/USD is not encoded in
the transaction.

Every live swap is also written to a persistent execution journal before it is
submitted. If the process stops after submission or confirmation but before the
position or trade is saved, the next live startup refuses to open new risk until
the incomplete execution is reconciled.

The `journal` command lists these executions. `journal-resolve` can only clear a
submitted transaction when Solana RPC proves it failed or expired; it cannot
dismiss a confirmed or still-unknown transaction.

---

## What does the system track?

Every token that scores high enough to evaluate is stored in the database. For each one, the system captures:

- The price at the time of scoring
- The highest price reached afterward (MFE — maximum favorable excursion)
- The lowest price reached afterward (MAE — maximum adverse excursion)
- Whether it would have hit the profit target
- Whether it would have hit the stop-loss

This **counterfactual dataset** tells you what would have happened to every token you considered, including ones you didn't trade. It is the foundation for threshold tuning.

---

## The reports

### `report`
Snapshot of current state: recent scored tokens, open positions, closed trades, recent events.

### `stats`
Performance summary for all closed trades:
- **Expectancy** — average P&L per trade. Positive = strategy makes money on average.
- **Win rate** — percentage of trades that closed in profit.
- **Profit factor** — gross wins divided by gross losses. Above 1.0 = profitable. Above 2.0 = strong.
- **By strategy** — Fresh Launch vs Migration broken out separately.
- **By exit reason** — trailing stops, stop-losses, timeouts. Tells you which exit rules are working.
- **By score bucket** — validates whether higher scores actually perform better.

### `outcomes`
The counterfactual view — all scored candidates whether traded or not. Shows average MFE/MAE and hit rate by score bucket. Answers: "is the entry threshold filtering correctly?"

### `tune`
Reads outcome data and produces specific, confidence-rated recommendations:
- "Raise the entry threshold from 75 to 80 — the 75-79 bucket hits stop-loss 53% of the time. [HIGH confidence]"
- "Take-profit ceiling of 50% is too low — best bucket averages +87% MFE. Raise to 200–300 and rely on trailing stop. [HIGH confidence]"
- Risk-signal notes when volume acceleration, holder concentration, or authority-status buckets contradict current assumptions.

`tune --apply` writes concrete numeric threshold recommendations directly to `config.yaml`; risk-signal notes stay advisory.

### `live-readiness`
Before switching to live mode, this command audits every prerequisite — wallet
file presence, RPC URL, position sizing, price-impact cap, confirmation policy,
and slippage config — without reading private keys or placing any trades.

---

## The improvement cycle

```
Use paper mode to calibrate, or switch to live when the owner is ready
        ↓
stats + strategies → is expectancy positive?
outcomes → is the threshold set correctly?
tune → what specifically needs to change?
        ↓
Adjust config.yaml
        ↓
Repeat until consistently profitable
        ↓
live-readiness → confirm all prerequisites met
recover-positions (dry-run) → confirm wallet in sync
Switch mode: live
```

---

## What "paper trading" means for reading results

Every P&L number in paper mode is simulated. The bot observed real market prices and calculated what would have happened.

The simulation is deliberately conservative:
- **Transaction fees** charged on every entry and exit (30 basis points per leg)
- **Price impact / slippage** charged from real Jupiter quotes at actual trade size
- **Exit prices** re-quoted from the market at exit time

This makes paper results a meaningful approximation of live performance. The main gap is **execution latency** — in paper trading the entry price is the price at scoring time; in live trading there is a small delay between scoring and on-chain confirmation.

---

## Quick reference: how to read a trade

```
live-12 SOLANA BONK strat=freshLaunchMomentum
  reason=trailing_stop source=fresh
  pnl=+$18.43 (+73.7%) closed=2026-06-01T14:22:00Z
  entryTx=3xK9...YqW  exitTx=7mP2...NvR
```

- Position ID `live-12` (live prefix = real trade; paper prefix = simulated)
- Token symbol `BONK` on Solana, handled by Fresh Launch Momentum
- Exited via trailing stop, fresh market price, $18.43 gain (73.7%)
- `entryTx` and `exitTx` — Solana transaction signatures you can verify on-chain

```
paper-15 SOLANA PEPE strat=migrationMomentum
  reason=stop_loss source=fresh
  pnl=-$4.50 (-18.0%) closed=2026-06-01T14:35:00Z
```

- Simulated trade, Migration strategy
- Hit the stop-loss at −18%. Expected — not every trade wins.

---

## Current limitations

- **Only Solana.** The project intentionally focuses on Solana execution, recovery, and risk controls rather than maintaining partial multi-chain support.
- **Volume signals are 5-minute snapshots.** The acceleration signal helps, but very brief spikes within the 5-minute window are not tracked at sub-minute resolution.
- **Outcome-tracking has selection bias.** Unpriceable candidates (no market data when re-priced) are not sampled, so outcome analytics skew toward tokens that stayed liquid enough to price.
- **Network fees are included in live trade P&L when they can be valued.** Raw lamport fees are always stored; entry and exit fees are valued in USD when SOL pricing is available.
