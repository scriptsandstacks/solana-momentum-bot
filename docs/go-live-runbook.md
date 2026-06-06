# Solana Trade Engine Go-Live Runbook

This runbook is for the owner/operator preparing to run live Solana trading.
It is an operational checklist, not a permission gate. The owner can switch
between paper and live mode through configuration when ready.

## Pre-Flight

1. Verify code health.

```bash
npm test
npm run typecheck
git diff --check
```

2. Confirm static live prerequisites.

```bash
npm run bot -- live-readiness
```

`live-readiness` does not read wallet private keys or place trades. It checks
configuration, RPC environment, wallet-file presence, sizing policy, price
impact cap, SOL fee reserve target, confirmation policy, and paper calibration
data.

3. Confirm actual route-input inventory.

```bash
npm run bot -- wallet-balances
```

This loads the configured wallet and reads balances only. Confirm:

- SOL is above `chains.solana.minSolFeeReserveLamports`.
- USDC, USDT, or SOL inventory is sufficient for the intended position size.
- Total route-input value is consistent with the amount the owner expects to
  put at risk.

4. Confirm wallet and SQLite agree.

```bash
npm run bot -- recover-positions --dry-run
```

Do not start live trading with stale positions or orphaned on-chain holdings
unless the recovery plan is understood. If the plan is correct:

```bash
npm run bot -- recover-positions --yes
```

5. Confirm no incomplete live executions are blocking startup.

```bash
npm run bot -- journal
```

Resolve only RPC-proven failed or expired submissions:

```bash
npm run bot -- journal-resolve <journal-id>
```

## First Live Session

Use small size for the first live session to validate plumbing, not strategy
edge. This checks RPC behavior, Jupiter transactions, confirmation latency,
fill accounting, journal persistence, and exit handling under real conditions.

Before starting:

- Set `mode: live`.
- Keep `maxPriceImpactBps` tight enough for actual-size buys.
- Keep `minSolFeeReserveLamports` funded.
- Confirm `maxDailyLossUsd` matches the owner's intended stop for the session.
- Export the RPC and PumpPortal environment variables in the shell that starts
  the process.

```bash
SOLANA_RPC_URL=https://... PUMPPORTAL_API_KEY=... npm run bot -- run
```

Watch startup logs for:

- `mode=live`
- wallet public key and cash value
- no incomplete journal entries
- wallet reconciliation result
- token watcher startup

## During Live Trading

Monitor:

- `[trade] OPENED` and `[trade] CLOSED` lines
- transaction signatures
- `[run:exits]` and `[run:exits:fast]` failures
- cash and open-position counts
- RPC errors or slow confirmations
- SOL fee reserve via periodic `wallet-balances`

If the process reports an incomplete live execution, stop and inspect before
restarting. The journal exists so the operator can reconcile uncertain swaps
instead of double-opening or double-closing.

## Shutdown

Prefer a normal `Ctrl-C` / SIGINT shutdown. After shutdown:

```bash
npm run bot -- journal
npm run bot -- recover-positions --dry-run
npm run bot -- wallet-balances
```

If all three are clean, the system is ready for the next paper or live run.

## Recovery Priorities

1. Protect existing live positions first.
2. Resolve journal uncertainty before starting another run.
3. Reconcile wallet/SQLite stale or orphaned positions.
4. Refill SOL fee reserve if needed.
5. Resume only after the owner understands the current wallet state.

The system should never require paper cycles before live trading, but paper mode
remains useful for calibration, threshold tuning, and comparing strategy changes
without spending capital.
