# Drawdown Recovery Runbook

This runbook is for paper-mode recovery after a material drawdown. It assumes
the bot has been stopped and no open positions remain.

## Stop Condition

Stop the bot before making changes when any of these are true:

- portfolio drawdown is greater than 10%
- profit factor is below 0.8 after at least 30 trades
- stop-loss exits are the largest P&L driver
- the same mint is being opened by multiple strategies
- loss clusters are concentrated in a route input, token-age bucket, or strategy

Stop command:

```bash
pm2 stop solana-momentum-bot
```

Confirm it is stopped:

```bash
pm2 status solana-momentum-bot
```

## Diagnostics

Run these before restarting:

```bash
npm run bot -- stats
npm run bot -- strategies
npm run bot -- risk-report
npm run bot -- outcomes
```

For the June 2026 drawdown, the main drivers were:

- `migrationMomentum` underperformance
- duplicate mint exposure across strategies
- SOL-routed entries
- age-0 tokens
- sub-$25k liquidity tokens

## Recovery Controls

The conservative recovery config should keep:

```yaml
chains:
  solana:
    minLiquidityUsd: 25000

paper:
  positionSizeUsd: 10
  maxOpenPositions: 1
  maxDailyLossUsd: 25

entryFilters:
  minAgeMinutes: 3
  disallowedRouteInputSymbols:
    - SOL

strategies:
  freshLaunchMomentum:
    enabled: true
    minScoreToEnter: 75
  migrationMomentum:
    enabled: false
```

Code controls that must be present before restart:

- duplicate open exposure to the same mint is rejected
- disabled strategies are excluded from `buildStrategies`
- entry filters can score candidates without opening trades
- `risk-report` is available
- runtime-pipeline changes from PR #24 are deployed

## Verification

Before restarting:

```bash
npm run typecheck
npm test -- --run
npm run bot -- risk-report
```

The test suite should pass. `risk-report` should explain the old drawdown and
show why the active recovery filters are relevant.

## Deploy

After the recovery branch is merged to `development`:

```bash
git switch development
git pull origin development
npm install
npm run typecheck
npm test -- --run
```

The current PM2 process runs:

```text
npm run bot -- run
```

Because the safer limits are in `config.yaml`, no PM2 argument change is
required for the conservative recovery run.

Restart:

```bash
pm2 restart solana-momentum-bot --update-env
```

If the process was stopped and restart does not launch it:

```bash
pm2 start npm --name solana-momentum-bot -- run bot -- run
```

## First-Hour Monitoring

Watch logs:

```bash
pm2 logs solana-momentum-bot --lines 200
```

Healthy signs:

- `[run] started`
- `[run:process] ... ms=...`
- `[run:exits] ... ms=...`
- candidate processing continues without runaway failures
- no entries from `migrationMomentum`
- no `route=SOL` opened positions
- no duplicate mint positions

Stop immediately if:

- two stop-loss trades happen in the first hour
- daily P&L reaches `-$25`
- a duplicate mint position opens
- a SOL-routed position opens
- `migrationMomentum` opens a position
- exit checks stop updating while a position is open

## Post-Session Review

After every recovery session:

```bash
pm2 stop solana-momentum-bot
npm run bot -- stats
npm run bot -- strategies
npm run bot -- risk-report
npm run bot -- outcomes
```

Do not loosen filters until the recovery slice has enough evidence:

- at least 50 new trades under the recovery config
- profit factor above 1.2
- no duplicate mint exposure
- stop-loss average loss near the configured risk expectation
- no single route-input bucket dominates losses

