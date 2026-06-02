# Hermes — System Documentation

Technical reference for the Hermes paper trading bot. Covers architecture, data flow, strategy logic, exit rules, analytics, and CLI commands.

---

## Status

| Area | Status |
|---|---|
| Paper trading (Solana) | Active |
| Live trading | Not implemented — architecture ready |
| Base / Ethereum | Config present, disabled |
| Private key usage | Not used in paper mode |
| Persistence | SQLite |
| Test coverage | 23 files, 134 tests |

---

## High-level architecture

```
PumpPortal WebSocket
  new_token events → freshLaunchMomentum strategy
  migration events → migrationMomentum strategy
        ↓
DexScreener + Raydium enrichment (price, liquidity, volume, buy/sell counts)
        ↓
Jupiter route check (swappability, buy-side slippage, sell-route probe)
        ↓
Solana RPC mint authority check (mint/freeze authority revoked?)
        ↓
Strategy scorer → OpportunityScore (0–100)
        ↓
Entry decision (score ≥ strategy.config.minScoreToEnter AND broker has capacity)
        ↓
Position sizing (strategy.resolvePositionSizeUsd — conviction tiers)
        ↓
PaperBroker (simulated fill with cost model)
        ↓
SQLite (scored candidates, open positions, closed trades, events)
        ↓
Exit engine (re-price every interval → two-phase trailing stop)
        ↓
Analytics (stats, strategies, outcomes, tune)
```

---

## Strategies

### freshLaunchMomentum

**File:** `src/strategies/freshLaunchMomentum.ts`

**Edge:** A small fraction of new Pump.fun tokens sustain buy pressure through their first hour and can move 200-1000%. Strict scoring filters the majority that die immediately after creation.

**Event type:** `new_token` only

**Scorer signals (src/scoring/scoreToken.ts):**

| Signal | Strong | OK | Weak / Risk |
|---|---|---|---|
| Liquidity | ≥$50K (+24) | ≥$10K (+18) | <$10K (−14) |
| 5m volume | ≥$20K (+20) | ≥$5K (+14) | <$5K (+3) |
| Buy ratio (5m) | ≥65% and ≥50 trades (+16) | ≥50% and ≥20 trades (+9) | below (0) |
| Token age | 5–90 min (+10) | <5 min (+2) | >90 min (+5) |
| 5m price change | 0–40% (+10) | — | >40% (+3), negative (0) |
| Jupiter buy route | available (+15) | — | none (−25) |
| Estimated slippage | ≤300 bps (+5) | — | >500 bps (−10) |
| Sell route | present (0) | — | absent (−50) |
| Mint authority | revoked (+5) | unchecked (0) | held (−20) |
| Freeze authority | revoked (+3) | unchecked (0) | held (−15) |

**Entry threshold:** score ≥ 75 (configurable via `scoring.minimumScoreToEnter`)

**Position sizing:**
- Score 90+: 1.5× base position size
- Score 80–89: 1.0× base
- Score 75–79: 0.75× base

**Exit rules:**
- Stop-loss: −20% from entry (hard floor, always active)
- Trailing arm: +30% — trailing stop only activates once the high-water mark reaches +30%
- Trailing stop: 15% pullback from peak (phase 2 only)
- Safety ceiling: +300% fixed take-profit (almost never fires; trailing stop is the real exit)
- Max hold: 60 minutes

---

### migrationMomentum

**File:** `src/strategies/migrationMomentum.ts`

**Edge:** When a Pump.fun token's bonding curve reaches 100% completion (~$69K raised), the protocol executes a large structural buy that seeds Raydium liquidity. The token has already survived price discovery on Pump.fun, so its liquidity is proven. The migration pump is typically sharper and shorter than a fresh launch pump.

**Event type:** `migration` only

**Scorer signals:**

| Signal | Strong | OK | Weak / Risk |
|---|---|---|---|
| Liquidity | ≥$80K (+28) | ≥$40K (+20) | ≥$15K (+10), <$15K (−15) |
| 5m volume | ≥$30K (+22) | ≥$10K (+15) | ≥$2K (+7), <$2K (−5) |
| Buy ratio (5m) | ≥65% and ≥30 trades (+18) | ≥50% and ≥10 trades (+10) | below (−5) |
| Token age | ≤360 min (+8) | ≤720 min (+3) | >720 min (−8) |
| 5m price change | +5% to +60% (+10) | >0% (+5) | >60% (+2), negative (−5) |
| Jupiter buy route | available (+14) | — | none (−30) |
| Slippage | ≤200 bps (+5) | — | >500 bps (−8) |
| Sell route | present (0) | — | absent (−50) |
| Mint / freeze authority | same as above | | |

**Entry threshold:** score ≥ 70

**Position sizing:**
- Score 85+: 1.25× base
- Below 85: 1.0× base

**Exit rules:**
- Stop-loss: −18% from entry
- Trailing arm: +15% — trailing stop arms sooner (migration pumps start immediately)
- Trailing stop: 12% pullback from peak
- Safety ceiling: +200%
- Max hold: 25 minutes (migration pumps peak and fade quickly)

---

## Two-phase exit model

All strategies use a two-phase trailing stop to avoid clipping winners short while still cutting losers fast.

```
Phase 1 — position is below trailingArmPct gain
  Only the hard stop-loss applies.
  Trailing stop is inactive.
  Position can breathe through normal volatility without being shaken out.

Phase 2 — high-water mark has reached trailingArmPct above entry
  Trailing stop activates at trailingStopPct below the peak.
  No ceiling on upside (takeProfitPct is set high as a safety net only).
  Position rides winners as far as they go.
```

**Why this matters:** A fixed 50% take-profit on a memecoin that peaks at +400% leaves 350% on the table. A trailing stop that activates too early (e.g. after any 1% gain) shakes out the position on normal noise. The arm threshold prevents premature activation; the trailing stop then captures most of the move.

---

## Entry decision flow

For each pending PumpPortal event:

1. Fetch market data from DexScreener + Raydium
2. Filter: liquidity < `minLiquidityUsd` or volume < `minVolume5mUsd` → skip
3. Check Jupiter buy routes; probe sell route (honeypot detection)
4. Check Solana RPC mint/freeze authority (when RPC URL configured)
5. Route to strategy: `new_token` → freshLaunchMomentum, `migration` → migrationMomentum
6. Strategy tags candidate with `strategyId` and scores it
7. If `score < strategy.config.minScoreToEnter` → persist score, no entry
8. If broker capacity blocked (position cap, cash, daily-loss breaker) → persist score, note reason, add to retry queue
9. Otherwise: compute position size (`strategy.resolvePositionSizeUsd(score, base)`), open paper position

---

## Paper broker

**File:** `src/paper/paperBroker.ts`

Implements `ExecutionBroker` interface (`src/execution/broker.ts`). Simulates fills without touching real funds.

**Cost model** — fills are not frictionless:
- **Entry:** effective buy price = mid × (1 + feeBps/10000 + routeSlippageBps/10000). Fewer tokens per dollar than the mid price.
- **Exit:** realized proceeds = mid × (1 − feeBps/10000 − sellSlippageBps/10000). Sell slippage is re-quoted from Jupiter at actual position size (ExactOut).

**State restored from SQLite on every pass** — cash, open positions, position-id sequence, and daily P&L for the circuit breaker all survive process restarts.

**Circuit breakers:**
- `maxOpenPositions`: no new entries when at cap
- Cash: no entry if cash < required position size
- `maxDailyLossUsd`: no new entries once today's net realized P&L ≤ −maxDailyLossUsd; resets at UTC midnight

---

## Live trading transition

The `ExecutionBroker` interface is the seam. The bot pipeline speaks only to this interface. To add live trading:

1. `src/execution/liveBroker.ts` — implement `ExecutionBroker`
2. `openPosition()` → submit Jupiter swap, sign with wallet keypair
3. `closePosition()` → submit sell transaction
4. CLI `run`: branch on `config.mode === 'live'`, build `LiveBroker` instead of restoring `PaperBroker`

No changes needed to `pumpProcess`, `exitPositions`, `runLoop`, or any strategy.

---

## Analytics and reporting

### During `run`

| Log prefix | Content |
|---|---|
| `[trade] OPENED ...` | Strategy, score, entry price |
| `[trade] CLOSED ...` | Reason, P&L ($, %), hold time |
| `[cycle] ...` | Events processed, opened, closed, open count, cash |
| `[analytics] ...` | Full stats output every N passes (`--analytics-every`, default 10) |
| `[run:process] ...` | Raw enrichment / scoring counts |
| `[run:exits] ...` | Raw exit counts |

### CLI commands

**`stats`** — realized trade analytics broken down by:
- Strategy (freshLaunchMomentum vs migrationMomentum)
- Exit reason (stop-loss / trailing-stop / timeout)
- Exit price source (fresh price vs stale last-mark)
- Score bucket (75-79, 80-89, 90-100)
- Discovery source

Metrics per bucket: trades, wins, losses, win%, total P&L, expectancy (mean P&L/trade), avg win, avg loss, profit factor (gross wins ÷ gross losses), avg hold minutes.

**`strategies`** — compact per-strategy summary table.

**`outcomes`** — counterfactual MFE/MAE analytics for all scored candidates (whether traded or not). Answers: "at each score level, how far did candidates run and draw down over the trade horizon?"

**`tune`** — reads outcome data and emits actionable, confidence-rated recommendations:
- Whether to raise or lower the entry threshold (based on which score buckets hit SL > TP)
- Whether the fixed take-profit ceiling is cutting winners short (when avg MFE >> takeProfitPct)
- Whether the stop-loss could be tightened (when avg MAE is much smaller than the stop)

Sample output:
```
Threshold Tuning Recommendations
Based on 143 tracked candidates
Current: entry≥75  SL=20%  TP=300%

Outcome by score bucket:
  Bucket        n    avgMFE   avgMAE    hitTP%   hitSL%
  <75          48    +11.2%  -18.4%       15%      69%
▶ 75-79        38    +28.1%  -14.2%       32%      53%
▶ 80-89        45    +52.3%   -9.7%       56%      33%
▶ 90-100       12    +87.4%   -5.1%       83%       8%

Recommendations:
  [HIGH] scoring.minimumScoreToEnter
    Current: 75
    Suggest: Raise to 80
    Why:     Score bucket 75-79 hits stop-loss more often than take-profit...
```

---

## Data pipeline — detailed

### PumpPortal websocket

Subscribes to `subscribeNewToken` and `subscribeMigration` free streams. Events are persisted to `pumpportal_events` immediately as they arrive, then processed asynchronously by `pump-process` or the `run` loop.

Each event stores: `eventType`, `tokenMint`, `symbol`, `name`, `signature`, `rawJson`, `receivedAt`, `processingStatus`, `processingNote`.

Events with no market data yet remain `pending` and are retried up to 5 times before being skipped.

### DexScreener + Raydium enrichment

For each pending mint, the bot fetches in parallel:
- **DexScreener** `/tokens/<mints>`: pair data, price, liquidity, volume (5m, 1h), buy/sell counts, momentum
- **Raydium** pool endpoint: pool data, TVL

Results are merged per mint: price/liquidity/pair from the deepest pool; volume/buy-sell counts/momentum from DexScreener (which has live activity; Raydium does not). Keeps the best candidate per mint.

### Jupiter route check

For each viable candidate:
1. Quotes a small fixed buy (SOL→token, USDC→token, USDT→token) — keeps the best (lowest slippage) route
2. Probes a small sell ($5 ExactOut: token→USDC) — if no quote, flags `sellRouteAvailable: false` (honeypot signal, −50 pts)

### Solana RPC authority check

`getAccountInfo` with `jsonParsed` encoding on the token mint address. Reads `mintAuthority` and `freezeAuthority` from the SPL token mint account. Best-effort with 5-second timeout; returns unknown if RPC is unreachable. Only runs when `solanaConfig.rpcUrlEnv` resolves to a URL.

---

## SQLite schema

**`scored_candidates`** — every candidate that passed the liquidity/volume pre-filter, whether entered or not. Includes forward-outcome columns populated by `track-outcomes`:

```
id, chain, address, symbol, strategy_id, token_json, score, recommendation,
reasons, risks, source, price_usd, liquidity_usd, volume_5m_usd,
route_available, sell_route_available, estimated_slippage_bps,
outcome_high_usd, outcome_low_usd, outcome_last_usd,
outcome_first_take_profit_at, outcome_first_stop_loss_at,
outcome_done, created_at
```

**`open_positions`** — currently open simulated positions. Includes `high_water_mark_usd` and `last_mark_usd` for trailing-stop math.

**`closed_trades`** — completed paper trades with entry/exit price, quantity, P&L, exit reason, and exit price source.

**`pumpportal_events`** — raw WebSocket events with processing status.

---

## Configuration reference

```yaml
mode: paper             # 'paper' | 'live' (live not yet implemented)

chains:
  solana:
    enabled: true
    walletFile: ./wallet/chain-solana.txt   # used only in live mode
    rpcUrlEnv: SOLANA_RPC_URL               # env var for mint authority checks
    minLiquidityUsd: 10000                  # pre-filter before scoring
    minVolume5mUsd: 5000
    maxSlippageBps: 500

paper:
  startingBalanceUsd: 1000
  positionSizeUsd: 25      # base size, scaled by strategy conviction tiers
  maxOpenPositions: 3
  maxDailyLossUsd: 100     # circuit breaker; resets at UTC midnight

exits:                     # global defaults; each strategy may override
  stopLossPct: 20
  takeProfitPct: 300       # safety ceiling — trailing stop is the real exit
  trailingStopPct: 15      # pullback from peak (phase 2)
  trailingArmPct: 30       # phase 2 activates once HWM reaches +30%
  maxHoldMinutes: 60

fees:
  swapFeeBps: 30           # per-leg swap + priority fee (entry and exit)
  applyRouteSlippage: true # also charge route price impact

scoring:
  minimumScoreToEnter: 75  # freshLaunchMomentum threshold

retention:
  scoredCandidateDays: 30  # prune untraded scored candidates after this
```

---

## File map

```
src/
  cli/index.ts                    CLI entrypoint and command wiring
  config/schema.ts                Zod config schema
  config/loadConfig.ts            YAML loader

  strategies/types.ts             TradingStrategy interface + StrategyConfig
  strategies/freshLaunchMomentum.ts  Fresh launch strategy + scorer
  strategies/migrationMomentum.ts    Migration strategy + scorer

  execution/broker.ts             ExecutionBroker interface (paper/live seam)
  paper/paperBroker.ts            PaperBroker (implements ExecutionBroker)
  paper/restoreBroker.ts          SQLite → PaperBroker state restoration

  scoring/scoreToken.ts           freshLaunchMomentum scorer (used by strategy)

  bot/pumpProcess.ts              Event → strategy routing → enrichment → entry
  bot/exitPositions.ts            Exit engine: re-price + two-phase trailing stop
  bot/retryBlockedOpens.ts        Retry capacity-blocked entries after exit pass
  bot/runLoop.ts                  Main loop: watch + process + exit + outcomes
  bot/analytics.ts                Trade and outcome analytics
  bot/reporter.ts                 Reporter interface + consoleReporter
  bot/storageReport.ts            Persisted state report renderer
  bot/report.ts                   In-memory scan report renderer
  bot/tune.ts                     Threshold tuning recommendations
  bot/paperCycle.ts               One-shot scan + paper-trade cycle
  bot/pumpWatch.ts                Bounded PumpPortal listener
  bot/trackOutcomes.ts            Forward MFE/MAE capture for scored candidates

  chains/solana/scanner.ts        DexScreener-based Solana scan pipeline
  chains/solana/mintAuthority.ts  Solana RPC mint/freeze authority check

  discovery/dexscreener.ts        DexScreener pair discovery and token lookup
  discovery/jupiter.ts            Jupiter route check, sell probe, exit slippage quote
  discovery/pumpPortal.ts         PumpPortal WebSocket client
  discovery/raydium.ts            Raydium pool/liquidity enrichment

  storage/sqliteStore.ts          SQLite schema, migrations, repositories
  types/domain.ts                 Shared domain types
```

---

## Development

```bash
npm install
npm test                          # 23 test files, 134 tests
npm run typecheck                 # tsc --noEmit, must be clean
npm run bot -- --help             # show all commands
```

Never commit: `wallet/`, `.env`, `data/`, `logs/`, `node_modules/`.
Never log or commit: private keys, seed phrases, API keys.
