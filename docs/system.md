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
volume5mUsd        day volume prorated to 5 minutes
volume1hUsd        day volume prorated to 1 hour
source             raydium
```

DexScreener and Raydium candidates are merged by mint. If both sources return a candidate, the bot keeps the deeper-liquidity candidate while preserving both source labels.

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
3. Opens simulated paper positions for candidates above `minimumScoreToEnter`, subject to paper broker limits.
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

### `run`

```bash
PUMPPORTAL_API_KEY=your_key npm run bot -- run
```

Runs continuously until Ctrl-C/SIGTERM:

1. Connects one PumpPortal websocket.
2. Saves incoming free-stream events immediately.
3. Processes pending PumpPortal events every `--process-interval-seconds`.
4. Enriches, route-checks, scores, and paper-trades qualifying candidates.
5. Prints a compact processing summary each pass.
6. Closes the websocket and SQLite store on shutdown.

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

Exit rules are present in config:

```text
stopLossPct
takeProfitPct
trailingStopPct
maxHoldMinutes
```

The current implementation is still an MVP; exit automation and richer mark-to-market behavior should be expanded as the next paper-trading layer.

## Current limitations

- PumpPortal watch/process is now available as a continuous `run` command, but exit automation and cleanup still need to be expanded.
- Raydium discovery/enrichment is not implemented yet.
- Base and Ethereum modules are config placeholders only.
- No live trading exists.
- The paper broker is still a simple MVP and needs better exit/price-update loops.
- Route checks depend on public Jupiter availability and may fail or rate-limit.
- DexScreener search can return older tokens; PumpPortal and Raydium should improve freshness.

## Recommended next steps

1. Add Raydium pool discovery/enrichment.
2. Keep Jupiter route checks as the execution realism gate.
3. Add exit processing using updated prices and configured stop/take-profit/timeout rules.
4. Improve reports with historical performance by source and score bucket.
5. Add Base paper support only after Solana paper results are useful.

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
