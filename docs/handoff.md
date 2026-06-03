# Hermes Engineering Handoff

**Author:** Codex  
**Last updated:** 2026-06-03  
**Branch:** `codex/confirmed-live-fill-accounting`

## Current Health

```text
npm test          -> 36 files, 262 tests passing
npm run typecheck -> clean
git diff --check  -> clean
```

Hermes is intentionally Solana-only. Paper and live trading share the same
strategy and execution-broker interface, and the owner can switch modes through
configuration without completing any mandatory paper-trading cycle.

## Current Live Execution State

Live mode is functionally implemented:

- Jupiter quote and swap transaction construction
- Solana keypair signing and RPC submission
- Block-height-aware confirmation using Jupiter `lastValidBlockHeight`
- Confirmed transaction balance-delta parsing for actual fill accounting
- Actual entry quantity, entry basis, exit proceeds, and realized P&L
- Raw Solana entry/exit fee persistence in lamports
- USD-valued network fees included in live P&L when SOL/USD is available
- Entry and exit transaction signatures persisted and shown in reports
- Real-time token activity exit triggers plus a 10-second exit backstop
- Startup wallet/SQLite reconciliation
- Interactive `recover-positions` support for stale and orphaned positions
- Stablecoin-funded orphan buys recovered from recent wallet transaction history

## Important Files

| File | Purpose |
|---|---|
| `src/execution/liveBroker.ts` | Live broker state, entry, exit, cash, and P&L accounting |
| `src/execution/liveDeps.ts` | Production keypair, RPC, Jupiter, confirmation, and fill dependencies |
| `src/execution/solanaTransactionFill.ts` | Confirmed wallet balance-delta parser |
| `src/execution/solanaTransactionHistory.ts` | Recent wallet buy lookup for orphan recovery |
| `src/execution/solanaConfirmation.ts` | Block-height-aware transaction confirmation |
| `src/execution/walletReconciler.ts` | Wallet holdings versus SQLite position reconciliation |
| `src/execution/positionRecovery.ts` | Pure stale/orphan recovery transformations |
| `src/storage/sqliteStore.ts` | Auto-migrating persistence layer |
| `src/bot/runLoop.ts` | Main process, exit, outcome, and watcher orchestration |

## This Branch

This branch adds:

- Confirmed on-chain fill accounting instead of Jupiter quote-based accounting
- Solana network fee persistence and P&L attribution
- Solana-only configuration and type boundaries
- Transaction signatures and network fees in persisted reports
- Transaction-history-based orphan recovery for USDC/USDT-funded buys
- Jupiter validity-window propagation and early expired-transaction failure
- Deterministic token watcher integration testing

## Remaining Risks

### Highest Priority

**Persistent live execution journal**

There is still a crash window after a swap is submitted or confirmed but before
the resulting position or trade is persisted. Add a SQLite-backed execution
journal that records intended swaps, transaction signatures, confirmation state,
and final persistence state. Startup recovery should inspect incomplete journal
rows before normal trading begins.

### Medium Priority

**Confirmation commitment**

Confirmation accepts both `confirmed` and `finalized`. Requiring only
`finalized` would reduce reorg risk but add latency. This is a trading-policy
decision rather than missing plumbing.

**Stale position auto-handling**

Failed live exits are isolated per position, but stale SQLite positions remain
open until `recover-positions` is run. The exit path could detect and quarantine
stale positions automatically.

**SOL-funded orphan recovery valuation**

Stablecoin-funded buys recover an exact USD basis from transaction history.
SOL-funded or pruned-history recoveries still use current market price because
historical SOL/USD is not encoded in the transaction.

### Data Calibration

- Tune volume acceleration thresholds from `outcomes`.
- Validate holder concentration and authority penalties from observed MFE/MAE.
- Evaluate strategy thresholds independently after enough trades accumulate.

## Safe Continuation

```bash
npm test
npm run typecheck
git diff --check
```

Keep the paper-mode invariant intact when changing shared broker or run-loop
behavior. Never log or commit private keys, seed phrases, RPC keys, or API keys.
