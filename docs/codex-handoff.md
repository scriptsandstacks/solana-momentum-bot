# Codex Handoff — Live Trading Branch

**Last updated:** 2026-06-02 · **Branch:** `feature/live-broker-implementation`
**Counterpart:** `docs/claude-handoff.md`

This document describes the current state of the `feature/live-broker-implementation` branch for
Codex review and continuation. The branch is ready to merge to `development`.

---

## Branch health

```
npm test          → 32 files, 240 tests passing
npm run typecheck → clean
git diff --check  → clean
```

---

## What this branch adds

All work is on top of `development` (post PR #11). The branch implements the full live trading
execution path and several production-safety features.

### Core live trading

| File | What |
|---|---|
| `src/execution/broker.ts` | `openPosition` and `closePosition` are now `async` / `Promise<>`. `PaperBroker` wraps unchanged sync logic. All callers updated. |
| `src/execution/liveBroker.ts` | Full `ExecutionBroker` implementation. `openPosition`: get Jupiter quote → build swap tx → sign with keypair → `sendTransaction` RPC → confirm → return position with `entryTxSignature`. `closePosition`: sell-to-USDC path with `exitTxSignature`. State managed in-memory (restored from SQLite at startup via `LiveBroker.restore()`). |
| `src/execution/jupiterSwap.ts` | `getJupiterQuoteForSwap` and `getJupiterSwapTransaction`. Shared host-selection logic (keyed/keyless). |
| `src/execution/liveDeps.ts` | Production deps factory: `loadSolanaKeypair` (64-byte JSON array), `createLiveBrokerDeps` (sign/send via `@solana/web3.js`, confirmation polling via `getSignatureStatuses`, token decimals cached per mint, SOL price from Jupiter). |
| `src/execution/brokerFactory.ts` | Updated to pass full `LiveBrokerOptions` when creating in live mode. |
| CLI `run` command | Detects `mode: live`, loads keypair, queries SOL balance for initial cash, constructs `LiveBroker.restore()`, passes it to `runBotLoop`. |

### Real-time exit triggers

| File | What |
|---|---|
| `src/execution/tokenActivityWatcher.ts` | WebSocket `logsSubscribe` to Solana RPC. One connection per run, per-mint subscriptions. Debounced `onActivity` callback (1 s). Auto-reconnects with backoff, re-subscribes all mints after reconnect. Only fires on `err: null` transactions. |
| `src/bot/runLoop.ts` | `createTokenWatcher` factory option. Syncs subscriptions to open positions after every pass. On activity: fires `runExitOnlyPass()` immediately; if main pass is in-flight, sets `activityPendingExit` flag and runs after. |
| CLI `run` | Adds `exitIntervalMs` (default 10 s in live mode, disabled in paper). `--exit-interval-seconds` flag overrides. |

### Production safety

| File | What |
|---|---|
| `src/execution/walletReconciler.ts` | `reconcileWalletPositions`: queries SPL token balances via `getTokenAccountsByOwner`, detects ORPHANED (on-chain but not in SQLite) and STALE (SQLite but no on-chain balance) positions. Excludes USDC/USDT/wSOL and dust. |
| `src/execution/positionRecovery.ts` | Pure functions: `buildStaleRecovery` (closes stale position at last-mark price, reason=manual), `buildOrphanedRecovery` (synthetic `PaperPosition` at current market price). |
| CLI `recover-positions` | Interactive recovery: shows plan, confirms, executes via `saveClosedTrade` / `saveOpenPosition`. `--dry-run` and `--yes` flags. |
| `src/bot/exitPositions.ts` | Added per-position try/catch. A failed live sell no longer aborts the entire exit pass. New `failed` field on `ProcessExitsResult`. |

### Config and schema

| Change | Detail |
|---|---|
| `priorityFeeLamports` | Added to `chainConfigSchema` as `number \| 'auto'`. Wired to Jupiter swap params. |
| `rpcUrlEnv` (docs) | Added clear inline comment to `config.example.yaml`. |
| `entry_tx_signature` | Added to `open_positions` via `addColumnIfMissing` migration. |
| `exit_tx_signature` | Added to `closed_trades` via `addColumnIfMissing` migration. |
| `getNextPositionSeq` | Now handles `live-N` IDs alongside `paper-N`. |
| `LiveBroker.getWalletPublicKey()` | Exposes `deps.getPublicKey()` for the reconciler CLI path. |

---

## Architecture changes from the broker async refactor

The `ExecutionBroker` interface now has:

```typescript
openPosition(...): Promise<PaperPosition>
closePosition(...): Promise<PaperTrade>
```

`PaperBroker` methods are `async` but synchronous inside (`return { ... }` with no awaits). The callers (`pumpProcess`, `exitPositions`, `retryBlockedOpens`, `paperCycle`) all `await` the results. All existing tests were updated for `async` and pass.

---

## Items Codex should review

### 1. Confirmation polling strategy
`liveDeps.ts` polls `getSignatureStatuses` every 2 s for up to 90 s. Questions:
- Is 90 s the right timeout for confirmed-but-not-finalized?
- Should we use `commitment: finalized` vs `confirmed`?
- Is 2 s poll interval appropriate or should we use `lastValidBlockHeight`-based looping?

### 2. Fill price accuracy
`openPosition` uses `quote.outAmount` (expected output, with slippage baked in) to compute `quantity` and `entryPriceUsd`. The actual fill after confirmation might differ by up to `maxSlippageBps / 100` %. For production accuracy, consider parsing the confirmed transaction's token transfer logs for the real fill. This is future work, documented in the handoff.

### 3. Stale position handling in exit pass
If `close-position` throws for a stale position (tokens gone, no sell route), the error is now caught per-position (new `failed` counter). The stale position stays open in SQLite until `recover-positions` cleans it up. This is safe but could be improved: the exit pass could auto-detect stale positions via the reconciler and skip them without erroring.

### 4. Token activity watcher debounce
Default debounce is 1 s. For very high-frequency tokens (Pump.fun during peak trading), this could delay the exit trigger by up to 1 s after the last log notification. Is 1 s correct, or should it be 500 ms?

### 5. Orphaned recovery entry price
`buildOrphanedRecovery` uses current market price as the entry price, which is approximate. The actual entry price would require parsing the buy transaction's token transfer logs (not implemented). For analytics accuracy, this means recovered positions will show near-zero P&L initially but will diverge from actual P&L as the market moves. This is noted in the plan output.

---

## Remaining open items (not in this branch)

From the `claude-handoff.md`:

- **Volume acceleration calibration** — signal is persisted and in the outcome report; needs paper data to tune the z-score thresholds and bonuses
- **Risk-signal threshold calibration** — holder concentration and authority penalties are conservative defaults; tune from `outcomes` after data accumulates
- **Transaction log parsing** — for exact fill prices and orphaned recovery entry prices

---

## Test coverage summary

| File | Tests |
|---|---|
| `tests/liveBroker.test.ts` | 24 — covers canOpenPosition, openPosition, closePosition, recordMark, tx signatures, state restoration |
| `tests/tokenActivityWatcher.test.ts` | 14 — covers subscribe/unsubscribe, debounce, failed-tx skip, reconnect, runLoop integration |
| `tests/walletReconciler.test.ts` | 15 — covers matched, orphaned, stale, stablecoin exclusion, dust, fill tolerance, RPC error |
| `tests/positionRecovery.test.ts` | 18 — covers pnl math, last-mark vs entry-fallback, zero price, rendering |
| `tests/brokerFactory.test.ts` | 5 — updated for async interface |
| `tests/paperBroker.test.ts` | 9 — updated for async interface |
| `tests/paperCycle.test.ts` | 3 — updated for async interface |
| `tests/runLoop.test.ts` | 9 — includes exit-interval and token watcher tests |

All other test files (22+) are unchanged in behavior; only `failed: 0` was added to exit result mocks.
