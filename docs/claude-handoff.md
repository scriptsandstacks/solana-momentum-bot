# Claude Handoff — Strategy, Execution & Reporting Architecture

**Last updated:** 2026-06-02 · **Branch:** `feature/live-broker-implementation`
**This session added:** WebSocket real-time exit triggers (Session 2) · On-chain position reconciliation (Session 3) · `recover-positions` command (Session 4)
**Reviewer:** Claude. Counterpart: `docs/codex-handoff.md`.

---

## Current health

```
npm test          → 32 files, 240 tests passing
npm run typecheck → clean
git diff --check  → clean
```

---

## Everything built on this branch (feature/live-broker-implementation)

Built on `development` after PR #11 merge. All commits sit on top of the
`codex/volume-acceleration-signal` work (PR #11).

### Session 4 — `recover-positions` command

| Area | What |
|---|---|
| `src/execution/positionRecovery.ts` | Pure transformation functions for recovery. `buildStaleRecovery(position, closedAt)` builds a `PaperTrade` from a stale SQLite position using `lastMarkUsd` (or `entryPriceUsd` as fallback) as exit price, reason=`manual`. `buildOrphanedRecovery(holding, candidate, positionId, openedAt)` builds a synthetic `PaperPosition` using the current market price as approximate entry — returns `currentPriceUsd: undefined` when no price is available (skipped). `renderRecoveryPlan` / `renderRecoverySummary` format operator-facing output. |
| `recover-positions` CLI command | Runs wallet reconciliation, fetches market prices for orphaned mints via `fetchPumpPortalMarketCandidates`, shows a human-readable recovery plan, prompts for confirmation (skippable with `--yes`, suppressed by `--dry-run`), then writes to SQLite: `saveClosedTrade` for stale positions, `saveOpenPosition` for orphaned holdings. Price-unavailable orphans are skipped with a warning. |
| Tests | 18 tests in `tests/positionRecovery.test.ts` covering pnl math, last-mark vs entry-fallback selection, zero/missing price handling, plan rendering, and summary formatting. |

### Session 3 — On-chain position reconciliation

| Area | What |
|---|---|
| `src/execution/walletReconciler.ts` | Queries wallet SPL token balances via `getTokenAccountsByOwner` and cross-references against SQLite `open_positions`. Returns two discrepancy types: **ORPHANED** (token held on-chain, no SQLite record — likely a crash between confirmed swap and `saveOpenPosition`) and **STALE** (position in SQLite, no meaningful on-chain balance — possible manual close or external sell). Known stablecoins (USDC, USDT, wSOL) excluded from orphaned detection. Dust amounts (< 0.001 UI units) excluded. Positions with ≥ 1 % of expected balance are treated as matched (fill tolerance). Best-effort: RPC failure returns an error field rather than throwing. |
| `renderReconciliationReport()` | Human-readable output with `[reconcile] OK/ORPHANED/STALE/WARNING` lines. Empty string when no positions and no issues. |
| `LiveBroker.getWalletPublicKey()` | Exposes the wallet public key via `deps.getPublicKey()` so the CLI can pass it to the reconciler without re-loading the keypair file. |
| CLI `run` startup | After `buildLiveBrokerIfNeeded`, calls `reconcileWalletPositions` and logs the report. Non-blocking — discrepancies are logged as warnings and the run loop continues. |
| `processExits` hardening | Added per-position try/catch so a single failed live swap (e.g. no on-chain balance for a stale position) no longer crashes the entire exit pass. Failed positions are counted in the new `failed` field on `ProcessExitsResult` and logged via `onLog`. The position stays open and is retried on the next exit pass. |
| Tests | 15 tests in `tests/walletReconciler.test.ts` covering matched, orphaned, stale, stablecoin exclusion, dust exclusion, fill tolerance, RPC error, and mixed scenarios. `runLoop.test.ts` and other test files updated for the new `failed` field. |

### Session 2 — WebSocket real-time exit triggers

| Area | What |
|---|---|
| `src/execution/tokenActivityWatcher.ts` | Subscribes to Solana RPC `logsSubscribe` WebSocket notifications for a set of token mints. Single shared WebSocket; per-mint subscriptions with subscription-ID tracking; debounced `onActivity` callback (1 s default); automatic reconnect with exponential backoff and full re-subscription after reconnect. Only fires for successful transactions (skips `err != null`). |
| `rpcUrlToWs()` | Utility to convert `https://` RPC URL to `wss://` WebSocket URL (same host/path, different protocol — works for Helius, QuickNode, Alchemy). |
| `runBotLoop` — `createTokenWatcher` option | Factory that, given the activity handler, returns a watcher. The run loop creates the watcher once, calls `watch(mint)`/`unwatch(mint)` after every pass to keep subscriptions in sync with open positions, and immediately fires an exit-only pass when activity is detected. If a main pass is in-flight when activity fires, sets `activityPendingExit` and runs the exit pass as soon as the main pass finishes. |
| Activity-triggered exits | Zero delay from on-chain trade to exit evaluation. Was previously limited by the 10 s exit interval; now the watcher triggers `runExitOnlyPass()` the moment any held token has a confirmed transaction. The 10 s interval remains as a backstop. |
| CLI `run` command | Creates a `TokenActivityWatcher` in live mode using the Solana RPC URL. The watcher connects on startup and automatically tracks all open positions. |
| Tests | 11 tests in `tests/tokenActivityWatcher.test.ts` covering subscribe/unsubscribe, notification handling, debounce, failed-tx skip, reconnect re-subscription, and `runBotLoop` integration. `rpcUrlToWs` has 3 tests. |

### Session 1 — LiveBroker implementation

| Area | What |
|---|---|
| `ExecutionBroker` interface | `openPosition` and `closePosition` are now `Promise<>` — the correct seam for an async live execution engine. `PaperBroker` wraps synchronous logic in `async`/`Promise` with no behavior change. |
| `LiveBroker` | Full implementation: `canOpenPosition` checks wallet config + cash + daily-loss limit; `openPosition` gets a fresh Jupiter quote, builds the swap transaction, signs with the loaded keypair, submits to the RPC, polls for confirmation, and records the actual fill; `closePosition` sells the full tracked token quantity to USDC via the same flow. Both methods store the on-chain transaction signature (`entryTxSignature`, `exitTxSignature`) on the returned `PaperPosition`/`PaperTrade` for audit. `LiveBroker.restore()` loads positions from SQLite and seeds cash from the on-chain wallet balance. |
| `src/execution/jupiterSwap.ts` | Jupiter quote + swap-transaction API. `getJupiterQuoteForSwap` returns the full quote object; `getJupiterSwapTransaction` POSTs to `/swap/v1/swap`. Uses same host-selection logic as the existing discovery quote path (keyed vs. keyless). |
| `src/execution/liveDeps.ts` | Production deps factory. `loadSolanaKeypair` reads a Solana CLI-format keypair file. `createLiveBrokerDeps` builds the injectable deps object: sign/send via `@solana/web3.js`, confirm via `getSignatureStatuses` polling (90s timeout, 2s interval), token decimals via `getAccountInfo` jsonParsed (cached per mint), SOL price via a 1 SOL → USDC quote. |
| Broker pass-through | `processPumpPortalEvents`, `processExits`, `retryBlockedOpens`, `runBotLoop` each accept an optional `broker?: ExecutionBroker`. When provided, used directly; when absent, reconstructs a `PaperBroker` from store (unchanged paper-mode behavior). |
| Decoupled exit interval | `runBotLoop` accepts `exitIntervalMs`. When set and smaller than `processIntervalMs`, a second interval fires exit-only passes independently of event ingestion. In live mode the CLI defaults this to 10 s so positions are protected on sub-30s timescales without burning PumpPortal processing quota. `--exit-interval-seconds` flag overrides. |
| CLI `run` command | Detects `mode: live`, loads keypair, queries on-chain SOL balance for initial cash, constructs `LiveBroker`, passes it to `runBotLoop`. Logs wallet address + initial cash + open position count at startup. |
| Config schema | Added `priorityFeeLamports: number | 'auto'` to `chainConfigSchema`. Wired from config into `createLiveBrokerDeps`. `'auto'` lets Jupiter pick a dynamic fee. |
| `config.example.yaml` | Added `rpcUrlEnv: SOLANA_RPC_URL` and `priorityFeeLamports: auto` with inline comments. |
| SQLite persistence | Added `entry_tx_signature` (open_positions) and `exit_tx_signature` (closed_trades) columns. Added via `addColumnIfMissing` migration so existing databases upgrade on next start. `getNextPositionSeq` now handles `live-N` ids alongside `paper-N`. |
| `liveReadiness` | Mode-gate check updated: passes when config is `live`, warns when still on `paper`. `liveExecutionImplemented` is now `true` in the CLI. |
| `@solana/web3.js` | Added as a production dependency (v1.98.x). Used only in `liveDeps.ts` for `Keypair.fromSecretKey` and `VersionedTransaction.deserialize` / `.sign`. All other Solana RPC calls use raw fetch so tests remain mockable. |
| Tests | 4 additional tests in `brokerFactory.test.ts`, 22 in new `liveBroker.test.ts`, 1 exit-interval test in `runLoop.test.ts`. All broker deps are injectable; no real keys or RPC needed. `paperBroker.test.ts` and `paperCycle.test.ts` updated for async interface. |

---

## Architecture: paper → live execution flow

```
CLI (run command, mode=live)
  → loadSolanaKeypair(walletFile)          # reads 64-byte JSON array
  → queryWalletCashUsd(publicKey, deps)    # lamports → SOL → USD
  → LiveBroker.restore(store, options, deps, initialCashUsd)
  → runBotLoop({ broker: liveBroker, exitIntervalMs: 10_000, ... })

Per event (processPumpPortalEvents):
  → broker.canOpenPosition()               # cash + cap + daily-loss check
  → broker.openPosition(candidate, score, sizeUsd)
       → getJupiterQuote(inputMint → tokenMint, inputAmount)
       → getSwapTransaction(quote, walletPubkey)
       → signAndSendTransaction(base64Tx)  # Keypair.sign + sendTransaction RPC
       → confirmTransaction(signature)     # getSignatureStatuses poll
       → return PaperPosition { entryTxSignature, entryPriceUsd, quantity }
  → store.saveOpenPosition(position)

Per exit (processExits, every 10 s in live):
  → broker.closePosition(positionId, triggerPrice, reason)
       → getJupiterQuote(tokenMint → USDC, tokenBaseUnits)
       → getSwapTransaction + sign + confirm
       → return PaperTrade { exitTxSignature, exitPriceUsd, pnlUsd }
  → store.saveClosedTrade(trade)
```

---

## Active strategies (unchanged)

### freshLaunchMomentum
- **Entry events:** `new_token` · **Threshold:** score ≥ 75 · **Sizing:** 1.5x/1x/0.75x
- **Exits:** SL=20%, arm at +30%, trail at 15%, hold max 60 min

### migrationMomentum
- **Entry events:** `migration` · **Threshold:** score ≥ 70 · **Sizing:** 1.25x/1x
- **Exits:** SL=18%, arm at +15%, trail at 12%, hold max 25 min

---

## CLI commands reference

| Command | Purpose |
|---|---|
| `run` | Main loop. `mode: live` enables real on-chain swaps. Flags: `--exit-interval-seconds` (default 10 in live, disabled in paper). |
| `recover-positions` | Detect and fix wallet/SQLite discrepancies. `--dry-run` previews without writing. `--yes` skips confirmation prompt. |
| `live-readiness` | Audits live-trading prerequisites. All blockers now clearable without code changes. |
| `report` | Persisted scores, positions (with strat=), trades (with strat=), events |
| `stats` | Full analytics: overall + by strategy, reason, score bucket, source |
| `strategies` | Compact per-strategy P&L table |
| `outcomes` | Candidate MFE/MAE counterfactual by score bucket |
| `tune` | Outcome data → threshold recommendations. `--apply` writes concrete updates. |
| `pump-watch` | Bounded PumpPortal listener |
| `pump-process` | Process pending events into scored candidates |
| `manage-exits` | One-shot exit pass |
| `track-outcomes` | Forward price capture for scored candidates |
| `prune` | Delete old untraded scored candidates |
| `check-route` | Read-only Jupiter route smoke test |

---

## Remaining open items

### Medium priority (live trading is now functionally complete)

**Volume acceleration analytics/tuning**
The signal is implemented, persisted, and reported by outcome bucket. Tune the z-score thresholds from observed MFE/MAE data once enough live history accumulates.

**Risk-signal threshold calibration**
Holder concentration ≥ 80 %, authority penalties, and volume acceleration weights are conservative defaults. Validate with the `outcomes` report.

**On-chain position reconciliation**
If the process crashes between a confirmed swap and `store.saveOpenPosition()`, the tokens exist on-chain but are not in SQLite. Add a startup check that reads the wallet's SPL token balances and flags any tokens not tracked in `open_positions`. This is the last gap before live mode is fully production-safe.

### Medium priority

**Volume acceleration analytics/tuning**
The signal is implemented, persisted, and reported by outcome bucket. Tune the z-score thresholds from observed MFE/MAE data once enough paper history accumulates.

**Risk-signal threshold calibration**
Holder concentration ≥ 80 %, authority penalties, and volume acceleration weights are conservative defaults. Validate with the `outcomes` report after enough tracked candidates accumulate.

### Minor

- The `report` and `storageReport` commands do not yet display `entryTxSignature` / `exitTxSignature`. These are persisted in SQLite; surfacing them in the human-readable report output would complete the audit trail.

---

## Resume notes

State at handoff:
- **Current branch:** `feature/live-broker-implementation`
- **All verification passed:**
  - `npm run typecheck` → clean
  - `npm test` → 32 files, 240 tests passing
  - `git diff --check` → clean
- The paper-mode invariant is fully intact — `PaperBroker` behavior is unchanged.
- All docs updated and accurate as of this session.

**Suggested next move:**
1. Open a PR from `feature/live-broker-implementation` → `development`.
2. After merge: run `live-readiness` against a real Helius RPC + wallet, then execute a single small test position before enabling full position sizing.
3. After a few days of live data accumulate: use `tune` and `outcomes` to calibrate signal weights and entry thresholds.

---

## Safe continuation checklist

```bash
npm test
npm run typecheck
git diff --check
```

If behavior changes beyond metadata/config, add a focused test proving old paper trading behavior is preserved or documenting the new behavior explicitly.
