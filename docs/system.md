# Hermes Agent Paper Trading System

This document describes how the current Solana-first paper-trading system works, what each component does, and how data flows through the bot.

## Current status

The system is a **paper-trading-only** crypto bot. It is designed to become multi-chain, but only Solana is enabled right now.

| Area | Status |
| --- | --- |
| Solana scanning | Enabled |
| Base support | Configured but disabled |
| Ethereum support | Configured but disabled |
| Paper trading | Enabled |
| Live trading | Not implemented |
| Private key usage | Not used in paper mode |
| Persistence | SQLite |
| Pump.fun discovery | PumpPortal free websocket events |
| Route validation | Jupiter quote API |

## Safety model

The current bot is intentionally conservative:

- It runs in `mode: paper` only.
- It does not execute real swaps.
- It does not need wallet private keys for the implemented commands.
- Wallet files live under `wallet/` and are ignored by Git.
- `.env`, local databases, logs, and `node_modules/` are ignored by Git.
- API keys should be passed through environment variables or CLI flags and should not be committed.

Live trading should not be added until paper-trading results are meaningful and safety/risk controls are expanded.

## High-level architecture

```text
Discovery sources
  ├─ PumpPortal websocket: new Pump.fun token and migration events
  ├─ DexScreener search/token lookup: broad Solana market candidates
  └─ Raydium mint pool lookup: pool/liquidity enrichment for PumpPortal mints
        ↓
Candidate normalization
        ↓
Liquidity / volume pre-filter
        ↓
Jupiter route check
        ↓
Opportunity scoring
        ↓
Paper broker simulation
        ↓
SQLite persistence
        ↓
CLI reports
```

The important design choice is that discovery and execution realism are separate:

- **PumpPortal** finds early Pump.fun events.
- **DexScreener** provides broad Solana pair/candidate metadata and token-market fallback enrichment.
- **Raydium** provides direct Solana pool/liquidity enrichment for PumpPortal mints when Raydium pools exist.
- **Jupiter** checks whether a candidate is actually swappable and estimates route price impact/slippage.
- **The scoring engine** decides whether to ignore, watch, or paper trade.
- **The paper broker** simulates entries without touching real funds.
- **SQLite** records data so scans and paper results can be reviewed later.

## Component map

```text
src/
  cli/index.ts                 CLI entrypoint and command wiring
  config/schema.ts             Zod schema for typed config validation
  config/loadConfig.ts         YAML config loader
  chains/solana/scanner.ts     Solana candidate scan pipeline
  discovery/dexscreener.ts     DexScreener candidate discovery
  discovery/jupiter.ts         Jupiter route/slippage validation
  discovery/pumpPortal.ts      PumpPortal websocket client and event normalization
  discovery/raydium.ts         Raydium mint pool/liquidity enrichment
  scoring/scoreToken.ts        Deterministic candidate scoring
  paper/paperBroker.ts         Paper position and trade accounting
  bot/paperCycle.ts            One scan + paper-trade cycle
  bot/pumpCandidates.ts        PumpPortal mint enrichment across DexScreener + Raydium
  bot/pumpWatch.ts             Bounded PumpPortal websocket watcher
  bot/report.ts                In-memory scan report renderer
  bot/storageReport.ts         Persisted SQLite report renderer
  storage/sqliteStore.ts       SQLite schema, migrations, and repositories
  types/domain.ts              Shared domain types
```

## Data sources

### PumpPortal

PumpPortal is used as the early Pump.fun event source.

Current subscriptions:

```text
subscribeNewToken
subscribeMigration
```

These are the free streams used for initial discovery. The bot does **not** subscribe to metered token/account trade streams.

The watcher uses one websocket connection and sends both subscription messages over that connection.

Stored event fields:

```text
eventType          new_token | migration | unknown
tokenMint          token mint if present
symbol             token symbol if present
name               token name if present
signature          transaction signature if present
rawJson            full raw event JSON
receivedAt         local receive timestamp
processingStatus   pending | processed | skipped | failed
processingNote     latest processing result
processedAt        processing timestamp
```

PumpPortal events are persisted first, then processed by `pump-process`. Processing tries to enrich each pending mint with DexScreener token market data and Raydium pool/liquidity data, keeps the deepest-liquidity candidate per mint, verifies a Jupiter route, scores the candidate, and opens a paper position only if the score passes the configured threshold. The `run` command combines watching and processing into one continuous loop.

### DexScreener

DexScreener is used by the Solana scanner to discover current Solana pairs/candidates. Candidates are normalized into the shared `TokenCandidate` shape.

The Solana scanner then filters candidates by config thresholds:

```text
minLiquidityUsd
minVolume5mUsd
```

### Raydium

Raydium is used as a pool/liquidity enrichment source for PumpPortal token mints. For each pending mint, the bot queries Raydium's mint pool endpoint, normalizes pools into `TokenCandidate`, and keeps the highest-TVL Raydium pool for that mint.

Raydium enrichment contributes:

```text
pairAddress        Raydium pool id
liquidityUsd       pool TVL
volume5mUsd        trailing-day volume prorated by the pool's active lifetime
volume1hUsd        trailing-day volume prorated by the pool's active lifetime
source             raydium
```

Raydium's `day.volume` is a trailing-24h total, not a recent rate. It is prorated by the pool's actual active lifetime (floored at 5 minutes, capped at one day) rather than a flat 24h split, so a fresh pool whose volume all accrued in its first minutes is not understated into failing the volume filter. For mature pools (≥ 1 day) this converges back to the flat day-split. Raydium does not report trade-level buy/sell counts or momentum, so those fields are left at zero on a Raydium candidate.

DexScreener and Raydium candidates are merged by mint into a single best view: price, liquidity, and pair come from the deepest (most tradable) pool, but volume, buy/sell counts, and momentum come from a source that actually reports them (DexScreener). This keeps a deeper Raydium pool from blanking out DexScreener's live activity signal — otherwise fresh Raydium-led mints would be filtered or scored as if they were dead. Both source labels are preserved.

### Jupiter

Jupiter is used as the route validation layer, not the primary discovery source.

For each viable candidate, the bot checks whether Jupiter can quote a swap into the token from several common inputs:

```text
SOL
USDC
USDT
```

The bot keeps the best available route by lowest estimated price impact/slippage.

Returned route metadata:

```text
routeAvailable
estimatedSlippageBps
routeInputMint
routeInputSymbol
```

A candidate with no Jupiter route is heavily penalized by scoring because it may not be realistically tradable.

## Why Jupiter and Raydium have different roles

Jupiter answers:

```text
Can we realistically swap this token, and with what route/price impact?
```

Raydium answers:

```text
Does this token have a Raydium pool, and what does that pool look like?
```

The system uses Jupiter because it aggregates multiple venues and gives better route realism for paper trading. Raydium now complements that by adding direct pool discovery/enrichment, especially for fresh mints where DexScreener coverage can lag.

Route checks call Jupiter's Swap API (the old `quote-api.jup.ag/v6` host was deprecated on 2025-10-01). The host is chosen automatically from whether a key is present, so the bot runs keyless out of the box and upgrades itself once a key is set:

- no key → `https://lite-api.jup.ag/swap/v1/quote` (keyless; deprecation postponed indefinitely as of 2026);
- `JUPITER_API_KEY` set → `https://api.jup.ag/swap/v1/quote` with the key sent as the `x-api-key` header (free key from <https://portal.jup.ag>).

`JUPITER_QUOTE_URL` overrides the host explicitly. The key is only an HTTP quote-API access key — it is read-only, never signs anything, and is unrelated to the wallet private keys forbidden in paper mode.

Current split:

```text
PumpPortal = early Pump.fun signal
Raydium = pool/liquidity discovery and enrichment
Jupiter = route validation and eventual Solana execution path
```

## Config

The default config lives in:

```text
config.yaml
```

A safe template lives in:

```text
config.example.yaml
```

Important current settings:

```yaml
mode: paper
chains:
  solana:
    enabled: true
  base:
    enabled: false
  ethereum:
    enabled: false
paper:
  startingBalanceUsd: 1000
  positionSizeUsd: 25
  maxOpenPositions: 3
scoring:
  minimumScoreToEnter: 75
```

The schema only accepts `mode: paper` today. That prevents accidentally enabling live behavior before it exists.

## CLI commands

Run commands from the project root:

```bash
cd /home/redman/development/projects/hermes-agent
```

Install dependencies:

```bash
npm install
```

Show command help:

```bash
npm run bot -- --help
```

### `scan`

```bash
npm run bot -- scan
```

Runs the Solana scanner once:

1. Loads config.
2. Fetches Solana candidates.
3. Applies liquidity/volume filters.
4. Checks Jupiter routes.
5. Scores candidates.
6. Saves scored candidates to SQLite.
7. Prints a report.

### `paper`

```bash
npm run bot -- paper
```

Runs one paper-trading cycle:

1. Scans candidates.
2. Scores them.
3. Opens simulated paper positions for candidates above `minimumScoreToEnter`, subject to paper broker limits. The broker is rehydrated from SQLite, so the position cap, cash, and the daily-loss breaker hold across runs (consistent with `pump-process`/`manage-exits`). Every candidate is still scored and persisted even when an open is blocked by capacity.
4. Saves scored candidates and open positions.
5. Prints a report.

This command still does not place real trades.

### `report`

```bash
npm run bot -- report
```

Prints persisted state from SQLite:

- recent scored candidates
- open paper positions
- closed paper trades
- PumpPortal events
- PnL summary
- win rate

### `stats`

```bash
npm run bot -- stats
```

Aggregates closed paper trades into performance analytics. Reports overall expectancy (mean PnL per trade), win rate, average win/loss, profit factor (gross wins ÷ gross losses), and average hold time, then breaks the same metrics down by:

- exit reason (stop-loss / take-profit / trailing-stop / timeout),
- exit price source (`fresh` vs stale `last_mark` / `entry_fallback`),
- entry score bucket (`75-79`, `80-89`, `90-100`),
- discovery source (PumpPortal / DexScreener / Raydium combinations).

This is the loop that tells you whether the score threshold and exit rules are paying off, and which discovery source is feeding good or toxic flow. It reads only persisted trades and makes no network calls.

### `pump-watch`

```bash
PUMPPORTAL_API_KEY=your_key npm run bot -- pump-watch --seconds 60
```

or:

```bash
npm run bot -- pump-watch --seconds 60 --api-key your_key
```

Watches PumpPortal free streams for a bounded duration, saves events to SQLite, and exits.

The command intentionally requires an API key and a positive `--seconds` value. It is bounded so the bot does not accidentally run forever in the foreground.

### `pump-process`

```bash
npm run bot -- pump-process --limit 50
```

Processes pending PumpPortal events:

1. Loads pending events with token mints from SQLite.
2. Fetches DexScreener token-pair data for those mints.
3. Applies Solana liquidity and 5-minute volume thresholds.
4. Checks Jupiter route availability and estimated slippage.
5. Scores each enriched candidate.
6. Saves the scored candidate.
7. Opens a simulated paper position only if the score passes `minimumScoreToEnter`.
8. Marks each event as `processed`, `skipped`, or `failed` with a note. Events with no market data yet remain `pending` so they can be retried later.

### `manage-exits`

```bash
npm run bot -- manage-exits
```

Runs one exit pass:

1. Rehydrates the paper broker from SQLite.
2. Re-prices every open position via DexScreener + Raydium.
3. Applies the configured stop-loss / take-profit / trailing-stop / max-hold rules.
4. Closes triggered positions, records the closed trade, and persists raised high-water marks for the rest.
5. Prints a compact summary of what was checked and closed.

### `check-route`

```bash
npm run bot -- check-route <mint>
```

Read-only smoke test: quotes a Jupiter route into the given token mint and prints whether a route exists, the chosen input asset, and the estimated slippage. Places no trade and touches no funds. Reports which host/key is in use, so it doubles as a quick way to confirm the Jupiter quote path is reachable before starting `run`.

### `run`

```bash
PUMPPORTAL_API_KEY=your_key npm run bot -- run
```

Runs continuously until Ctrl-C/SIGTERM:

1. Connects one PumpPortal websocket.
2. Saves incoming free-stream events immediately.
3. Processes pending PumpPortal events every `--process-interval-seconds`.
4. Enriches, route-checks, scores, and paper-trades qualifying candidates.
5. Runs an exit pass on the same interval, closing positions that hit their exit rules.
6. Prints a compact processing + exit summary each pass.
7. Closes the websocket and SQLite store on shutdown.

Useful options:

```bash
npm run bot -- run --process-interval-seconds 30 --process-limit 50
npm run bot -- run --seconds 60 --process-interval-seconds 10
```

Use `--seconds` for bounded smoke tests. Omit it for always-running mode.

## SQLite persistence

Default DB path:

```text
data/hermes-paper-bot.sqlite
```

This path is ignored by Git.

Current tables:

```text
scored_candidates
open_positions
closed_trades
pumpportal_events
```

### `scored_candidates`

Stores every scored candidate from `scan` or `paper`, including:

- token identity
- liquidity and volume data
- route availability
- estimated slippage
- selected route input asset
- score
- recommendation
- reasons and risks

### `open_positions`

Stores currently open simulated paper positions.

### `closed_trades`

Stores simulated closed trades and PnL.

### `pumpportal_events`

Stores raw and normalized PumpPortal new-token/migration events.

## Scoring and recommendations

Candidates are scored deterministically. The score produces one of these recommendations:

```text
ignore
watch
paper_trade
```

Signals that can improve a score include liquidity, volume, positive momentum, and healthy buy/sell flow.

Risks that can reduce or block a candidate include:

- weak liquidity
- weak volume
- weak buy pressure
- old token age
- negative momentum
- no Jupiter route
- high estimated slippage

A paper position should only be opened when the score meets the configured threshold and the paper broker has capacity.

## Paper broker behavior

The paper broker tracks simulated cash and positions using config values:

```text
startingBalanceUsd
positionSizeUsd
maxOpenPositions
```

When a candidate is accepted for paper trading, the broker calculates simulated token quantity from the candidate price and configured position size. No on-chain transaction is created.

### Trading-cost model

Paper fills are not frictionless. The `fees` config block worsens both legs so PnL is closer to reality, which matters most for thin pump.fun liquidity:

```yaml
fees:
  swapFeeBps: 30          # per-leg swap + priority fee, charged on entry and exit
  applyRouteSlippage: true # also charge the candidate's estimatedSlippageBps per leg
```

- **Entry:** the effective buy price is the mid worsened by the per-leg cost, so the same `positionSizeUsd` buys fewer tokens. The position's `entryPriceUsd` records this actual fill (so exit-rule PnL is measured against what was really paid), while the high-water and last marks track the observed mid for trailing-stop math.
- **Exit:** realized proceeds are reduced by the per-leg cost; the persisted `exitPriceUsd` is this net price, so reported PnL and cash reflect what the position would actually have fetched.

Slippage sourcing differs by leg. The entry leg uses the candidate's Jupiter route estimate (a small fixed buy probe). The exit leg, when `applyRouteSlippage` is on, fetches a **fresh sell-direction quote sized to the position** — a Jupiter ExactOut quote (token → exactly the position's USD value in USDC, so no token decimals are needed) whose price impact reflects what unwinding the actual position would cost. This is best-effort: if no sell quote is available, the broker falls back to the entry estimate. The sell quote is only requested for positions that are actually closing and only when the cost model applies route slippage, so frictionless runs make no extra network calls. When the `fees` block is omitted, fills are frictionless (the historical behavior).

Exit rules are enforced by the exit engine (`bot/exitPositions.ts`):

```text
stopLossPct        close when PnL <= -stopLossPct
takeProfitPct      close when PnL >= takeProfitPct
trailingStopPct    once price rose above entry, close on a drop of this % from the peak
maxHoldMinutes     close when the position has been held longer than this
```

Each open position carries a `highWaterMarkUsd` (initialized to the entry price and ratcheted up on every higher print) so trailing stops measure the drop from the peak, not from entry, plus a `lastMarkUsd` (the most recent observed price, not ratcheted). Exit priority is take-profit > stop-loss > trailing-stop > timeout.

When a pass has no fresh price for a position, the price-based exits (stop-loss, take-profit, trailing-stop) are skipped — they must react to a real current price. The time-based `maxHoldMinutes` timeout still fires, closing the position at its `lastMarkUsd` (or the entry price if it was never marked), so an unpriceable position cannot hold its slot indefinitely. A position that is neither priceable nor timed out is left open and retried on the next pass.

The exit engine rehydrates the `PaperBroker` from SQLite (open positions, cash, the daily-loss breaker, and the position-id sequence) so state is correct across passes and restarts. The same rehydration is used when opening positions, so `maxOpenPositions`, cash, and `maxDailyLossUsd` are enforced across passes — not just within a single process run.

### `maxDailyLossUsd` circuit breaker

`paper.maxDailyLossUsd` blocks new entries once the current UTC day's net realized PnL reaches `-maxDailyLossUsd`. The breaker is scoped per UTC day, so it resets at the day boundary even during a long-running `run`. Exits are never blocked by the breaker.

## Current limitations

- Base and Ethereum modules are config placeholders only.
- No live trading exists.
- Exit re-pricing reuses the DexScreener + Raydium lookup. Price-based exits need a fresh price, so a position with no current market data is only acted on once it hits its `maxHoldMinutes` timeout (closed at its last known mark); until then it is left open and retried.
- Route checks depend on public Jupiter availability and may fail or rate-limit.
- DexScreener search can return older tokens; PumpPortal and Raydium should improve freshness.

## Recommended next steps

1. Improve reports with historical performance by source and score bucket.
2. Add Base paper support only after Solana paper results are useful.

## Development checks

Before committing changes, run:

```bash
npm test
npm run typecheck
```

Optional CLI smoke checks:

```bash
npm run bot -- --help
npm run bot -- scan
npm run bot -- report
```

## Git and secret hygiene

Before committing, verify sensitive files are not staged:

```bash
git status --short
```

Files that must remain uncommitted/ignored:

```text
wallet/
.env
node_modules/
data/
logs/
```

Do not paste private keys, seed phrases, API keys, or wallet credential file contents into chat, commits, logs, or docs.
