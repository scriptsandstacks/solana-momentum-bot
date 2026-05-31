# Hermes Agent Paper Trading Bot

Solana-first, multi-chain-ready crypto paper trading bot for short-term token opportunities.

## Current scope

- Paper trading only by default.
- Solana enabled first.
- Base and Ethereum config are present but disabled.
- PumpPortal free websocket events are used for Pump.fun new-token/migration discovery.
- DexScreener is used for broad Solana candidate discovery and token market enrichment.
- Raydium is used as an additional Solana pool/liquidity enrichment source for PumpPortal mints.
- Jupiter is used for route/slippage validation.
- SQLite stores scored candidates, paper positions, closed paper trades, and PumpPortal events.
- Wallet files are ignored by Git and should only be used later for explicitly implemented live mode.

## Documentation

See the system documentation for the full architecture and data flow:

```text
docs/system.md
```

## Commands

```bash
npm install
npm test
npm run typecheck
npm run bot -- --help
```

Run a scan:

```bash
npm run bot -- scan
```

Run one paper-trading cycle:

```bash
npm run bot -- paper
```

Show persisted results:

```bash
npm run bot -- report
```

Check whether a token has a Jupiter route (read-only, no trade):

```bash
npm run bot -- check-route <mint>
```

Show paper-trade performance analytics (expectancy, win rate, PnL by reason / score / source):

```bash
npm run bot -- stats
```

Capture forward outcomes for scored candidates and report MFE/MAE by score bucket:

```bash
npm run bot -- track-outcomes
npm run bot -- outcomes
```

Prune old scored candidates that never led to a trade (trades are always kept):

```bash
npm run bot -- prune --dry-run
npm run bot -- prune
```

Watch PumpPortal free new-token/migration streams for a bounded duration:

```bash
PUMPPORTAL_API_KEY=*** npm run bot -- pump-watch --seconds 60
```

Process pending PumpPortal events into enriched/scored paper candidates:

```bash
npm run bot -- pump-process --limit 50
```

Re-price open paper positions and apply stop-loss / take-profit / trailing-stop / max-hold exits:

```bash
npm run bot -- manage-exits
```

Continuously watch PumpPortal and process pending events in one loop:

```bash
PUMPPORTAL_API_KEY=*** npm run bot -- run
```

For a bounded smoke test:

```bash
PUMPPORTAL_API_KEY=*** npm run bot -- run --seconds 60 --process-interval-seconds 10
```

## Safety

This project must not read private keys in paper mode and must never log private keys, seed phrases, API keys, or wallet credential file contents.

Ignored local/sensitive paths include:

```text
wallet/
.env
node_modules/
data/
logs/
```
