# Solana Trade Engine Engineering Handoff

**Author:** Codex  
**Last updated:** 2026-06-06
**Branch:** `codex/solana-operator-readiness`

## Current Health

```text
npm test          -> 38 files, 295 tests passing
npm run typecheck -> clean
git diff --check  -> clean
npm run bot -- --help -> clean; `wallet-balances` listed
```

Solana Trade Engine is intentionally Solana-only. Paper and live trading share the same
strategy and execution-broker interface, and the owner can switch modes through
configuration without completing any mandatory paper-trading cycle.
Project naming is now Solana Trade Engine across noticeable user-facing
surfaces; the CLI/package binary slug is `solana-trade-engine`.

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
- Persistent live execution journal for prepared, submitted, confirmed, persisted, and failed swaps
- Live startup blocks when submitted or confirmed executions remain unpersisted
- `journal` lists blocking executions; `journal-resolve` only clears RPC-proven failed or expired submissions
- Interactive `recover-positions` support for stale and orphaned positions
- Startup quarantine for stale positions: no repeated exits or new entries until recovery
- Stablecoin-funded orphan buys recover exact transaction-history basis; SOL-funded buys recover approximate basis from actual SOL spend and current SOL/USD
- Live cash inventory values SOL, USDC, and USDT; opens select the best actual-size quote among funded inputs and reject excessive price impact
- Configurable live confirmation commitment: `confirmed` for lower latency or `finalized` for stronger reorg protection
- Read-only `wallet-balances` command reports SOL, USDC, USDT, total route-input value, and configured SOL fee reserve status without placing trades
- Live opens preserve the configured SOL fee reserve; low-reserve wallets reject new entries before quote/sign/submit, while exits and recovery remain available

## Important Files

| File | Purpose |
|---|---|
| `src/execution/liveBroker.ts` | Live broker state, entry, exit, cash, and P&L accounting |
| `src/execution/liveDeps.ts` | Production keypair, RPC, Jupiter, confirmation, and fill dependencies |
| `src/execution/liveReadiness.ts` | Static live prerequisite and policy audit logic |
| `src/execution/solanaTransactionFill.ts` | Confirmed wallet balance-delta parser |
| `src/execution/solanaTransactionHistory.ts` | Recent wallet buy lookup for orphan recovery |
| `src/execution/solanaConfirmation.ts` | Block-height-aware transaction confirmation |
| `src/execution/liveExecutionJournal.ts` | Journal types and incomplete-execution rendering |
| `src/execution/walletReconciler.ts` | Wallet holdings versus SQLite position reconciliation |
| `src/execution/positionRecovery.ts` | Pure stale/orphan recovery transformations |
| `src/storage/sqliteStore.ts` | Auto-migrating persistence layer |
| `src/bot/runLoop.ts` | Main process, exit, outcome, and watcher orchestration |
| `docs/go-live-runbook.md` | Owner/operator live trading checklist and recovery sequence |

## Recent Live-Readiness Work

Recent live-readiness work adds:

- Confirmed on-chain fill accounting instead of Jupiter quote-based accounting
- Solana network fee persistence and P&L attribution
- Solana-only configuration and type boundaries
- Transaction signatures and network fees in persisted reports
- Transaction-history-based orphan recovery for USDC/USDT-funded buys
- Jupiter validity-window propagation and early expired-transaction failure
- Deterministic token watcher integration testing
- Persistent live execution journaling with operator inspection and safe resolution
- Stale-position quarantine after wallet reconciliation
- SOL, USDC, and USDT live cash inventory with mint-specific funding checks
- Actual-size live route selection across funded wallet inputs
- Actual-size live price-impact cap before signing swaps
- `live-readiness` audit surfaces the configured live price-impact cap
- Configurable live swap confirmation commitment
- SOL-funded orphan recovery uses recovered SOL input amount with current SOL/USD and labels the basis approximate
- Project naming is Solana Trade Engine across docs, reports, CLI metadata, and default SQLite/test paths
- Operator readiness adds configurable SOL fee reserve checks plus `wallet-balances` for read-only route-input inventory
- Runtime live opens enforce the SOL fee reserve and avoid SOL-funded routes that would spend below it
- Go-live runbook documents pre-flight checks, first live session, monitoring, shutdown, and recovery priorities

## Remaining Risks

### Medium Priority

No known medium-priority live-execution plumbing gaps remain. Remaining work is
mostly calibration and operator preference tuning.

### Data Calibration

- Use `tune` risk-signal notes to validate volume acceleration, holder concentration, and authority penalties from observed MFE/MAE.
- Evaluate strategy thresholds independently after enough trades accumulate.

## Safe Continuation

```bash
npm test
npm run typecheck
git diff --check
```

Keep the paper-mode invariant intact when changing shared broker or run-loop
behavior. Never log or commit private keys, seed phrases, RPC keys, or API keys.
