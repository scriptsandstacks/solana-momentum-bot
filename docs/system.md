# Solana Trade Engine — System Documentation

Technical reference for the Solana Trade Engine trading bot. Covers architecture, data flow, strategy logic, exit rules, analytics, live trading, and CLI commands.

---

## Status

| Area | Status |
|---|---|
| Paper trading (Solana) | Active |
| Live trading (Solana) | Implemented — Jupiter swap execution, keypair signing, on-chain confirmation |
| Supported chain | Solana only |
| Persistence | SQLite (auto-migrating schema) |
| Test coverage | 38 files, 290 tests |

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
Solana RPC risk checks (mint/freeze authority, holder concentration, volume acceleration)
        ↓
Strategy scorer → OpportunityScore (0–100)
        ↓
Entry decision (score ≥ strategy.config.minScoreToEnter AND broker has capacity)
        ↓
Position sizing (strategy.resolvePositionSizeUsd — conviction tiers)
        ↓
ExecutionBroker (PaperBroker or LiveBroker)
  Paper: simulated fill with cost model
  Live:  Jupiter swap → sign → submit → confirm → actual fill
        ↓
SQLite (scored candidates, open positions, closed trades, events, tx signatures)
        ↓
Exit engine
  Interval polling (30 s for paper, 10 s for live)
  + Solana RPC WebSocket activity triggers (live: immediate on trade detection)
  → Two-phase trailing stop
        ↓
Analytics (stats, strategies, outcomes, tune)
```

---

## Strategies

### freshLaunchMomentum

**File:** `src/strategies/freshLaunchMomentum.ts`

**Edge:** A small fraction of new Pump.fun tokens sustain buy pressure through their first hour and can move 200-1000%. Strict scoring filters the majority that die immediately after creation.

**Event type:** `new_token` only

**Scorer signals (`src/scoring/scoreToken.ts`):**

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
| Top-5 holder concentration | — | <80% (0) | ≥80% (−10) |
| Volume acceleration (z-score) | z≥2 (+6) | z≥1 (+3) | z≤−1 (−5) |

**Entry threshold:** score ≥ 75

**Position sizing:**
- Score 90+: 1.5× base
- Score 80–89: 1.0× base
- Score 75–79: 0.75× base

**Exit rules:**
- Stop-loss: −20% from entry (phase 1, always active)
- Trailing arm: +30% — trailing stop only activates once HWM reaches +30%
- Trailing stop: 15% pullback from peak (phase 2)
- Safety ceiling: +300% fixed take-profit
- Max hold: 60 minutes

---

### migrationMomentum

**File:** `src/strategies/migrationMomentum.ts`

**Edge:** Bonding curve completion executes a large structural buy seeding Raydium. Token has proven demand from Pump.fun price discovery. Migration pumps are sharp and short.

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
| Top-5 holder concentration | — | <80% (0) | ≥80% (−10) |
| Volume acceleration | z≥1 (+4) | — | z≤−1 (−4) |

**Entry threshold:** score ≥ 70

**Position sizing:**
- Score 85+: 1.25× base
- Below 85: 1.0× base

**Exit rules:**
- Stop-loss: −18% from entry
- Trailing arm: +15%
- Trailing stop: 12% from peak
- Safety ceiling: +200%
- Max hold: 25 minutes

---

## Two-phase exit model

```
Phase 1 — position is below trailingArmPct gain
  Only the hard stop-loss applies.
  Trailing stop is inactive (no premature shake-out on normal volatility).

Phase 2 — high-water mark has reached trailingArmPct above entry
  Trailing stop activates at trailingStopPct below the peak.
  Safety ceiling (takeProfitPct) acts as backstop only.
  Position rides winners as far as they go.
```

---

## Risk signals

### Mint / freeze authority (`src/chains/solana/mintAuthority.ts`)
`getAccountInfo` with `jsonParsed` on the token mint. Reads `mintAuthority` and `freezeAuthority`. Best-effort, 5 s timeout. Penalises held authority; bonuses for both revoked. Skipped silently if RPC is unreachable.

### Holder concentration (`src/chains/solana/holderConcentration.ts`)
`getTokenLargestAccounts` + `getTokenSupply` to compute the fraction held by the top-5 accounts. If top-5 hold ≥ 80% of supply, both strategies apply a −10 pt risk. Best-effort.

### Volume acceleration (`src/bot/volumeAcceleration.ts`)
Computes a z-score of the current 5-minute volume against the last 30 minutes of per-token snapshots stored in `token_volume_snapshots`. Positive z = accelerating; negative z = decelerating. Insufficient history (< 3 snapshots) returns undefined; scoring skips the signal.

---

## ExecutionBroker interface

**File:** `src/execution/broker.ts`

The seam between bot logic and execution engine. Both `PaperBroker` and `LiveBroker` implement it. `openPosition` and `closePosition` are async so live transaction submission fits naturally.

```typescript
interface ExecutionBroker {
  readonly mode: 'paper' | 'live';
  canOpenPosition(now?: Date, requiredSizeUsd?: number): { ok: boolean; reason?: string };
  openPosition(candidate, score, openedAt?, positionSizeUsd?): Promise<PaperPosition>;
  recordMark(positionId, priceUsd): PaperPosition;
  closePosition(positionId, exitPriceUsd, reason, closedAt?, exitPriceSource?, exitSlippageBps?): Promise<PaperTrade>;
  getCashUsd(): number;
  getRealizedPnlUsd(): number;
  getDailyRealizedPnlUsd(now?): number;
  getOpenPositions(): PaperPosition[];
  getClosedTrades(): PaperTrade[];
}
```

---

## Paper broker

**File:** `src/paper/paperBroker.ts`

Simulates fills without touching real funds.

**Cost model:**
- **Entry:** effective buy price = mid × (1 + feeBps/10000 + routeSlippageBps/10000)
- **Exit:** realized proceeds = mid × (1 − feeBps/10000 − sellSlippageBps/10000)

**State restored from SQLite on every pass** via `restoreBrokerFromStore`.

**Circuit breakers:** `maxOpenPositions`, cash floor, `maxDailyLossUsd` (resets UTC midnight).

---

## Live broker

**File:** `src/execution/liveBroker.ts`

Executes real on-chain trades via Jupiter and the Solana RPC.

**`openPosition` flow:**
1. `canOpenPosition()` — checks wallet config, cash, cap, daily-loss limit
2. `getWalletBalance` — finds which SOL, USDC, and USDT route inputs can fund the buy
3. `getJupiterQuoteForSwap` — quotes the actual `positionSizeUsd` across funded inputs, rejects routes above `maxPriceImpactBps`, and selects the highest token output
4. `getJupiterSwapTransaction` — POST to `/swap/v1/swap`
5. `VersionedTransaction.deserialize` → `tx.sign([keypair])` → `sendTransaction` RPC
6. `confirmTransaction` — polls `getSignatureStatuses` until `confirmationCommitment` is reached and aborts immediately if Jupiter's `lastValidBlockHeight` is exceeded; 90 s remains the fallback timeout
7. `getTransaction` — reads confirmed wallet balance deltas for the actual input and output amounts
8. Returns `PaperPosition` with actual fill quantity, price, and `entryTxSignature`

**`closePosition` flow:**
1. Quote token → USDC (`getJupiterQuoteForSwap`)
2. Build, sign, send, confirm
3. Read confirmed token and USDC balance deltas
4. Returns `PaperTrade` with actual USDC proceeds and `exitTxSignature`

Live accounting never uses Jupiter quote amounts as the recorded fill. Quote amounts
are estimates used only to construct the swap transaction. Confirmed transaction
balance deltas are the source of truth for position quantity, entry basis, exit
proceeds, and realized P&L. Raw Solana network fees are persisted in lamports and,
when SOL/USD pricing is available, valued in USD and included in realized P&L.

**Deps are injectable** (`LiveBrokerDeps`) — all network calls are mocked in tests; no real keys needed.

**Startup:** `LiveBroker.restore(store, options, deps, initialCashUsd)` seeds
position state from SQLite. Live cash is the USD value of the wallet's supported
route-input inventory: native SOL plus USDC and USDT token balances.

---

## Real-time exit triggers

**File:** `src/execution/tokenActivityWatcher.ts`

In live mode, a `TokenActivityWatcher` subscribes to the Solana RPC `logsSubscribe` WebSocket for each currently open token. When a confirmed transaction mentions a held mint, the watcher fires a debounced callback (1 s default), which triggers `runExitOnlyPass()` immediately rather than waiting for the next 10 s interval. A separate `exitIntervalMs` interval runs as a backstop.

The RPC WebSocket URL is derived from `rpcUrlEnv` by substituting `https://` → `wss://`.

---

## Startup reconciliation

**File:** `src/execution/walletReconciler.ts`

When `mode: live`, the `run` command queries wallet SPL token balances (`getTokenAccountsByOwner`) and compares with `open_positions` in SQLite. Two discrepancy types:

- **ORPHANED** — token held on-chain but absent from SQLite. Likely from a crash after swap confirmation but before `saveOpenPosition`. Use `recover-positions` to register a synthetic position.
- **STALE** — position in SQLite but no on-chain balance. Likely manually sold or a partial fill. Use `recover-positions` to close it out.

During `run`, stale positions are quarantined in the live broker after a
successful reconciliation. They remain in SQLite for audit and recovery, but
are excluded from automated exit attempts and block new entries until
`recover-positions` resolves them.

For orphaned holdings, `recover-positions` scans recent successful wallet
transactions and parses confirmed balance deltas. USDC/USDT-funded buys recover
the original transaction signature, block time, token fill, network fee, and
exact USD entry basis. SOL-funded buys recover the original transaction
signature, block time, token fill, network fee, and an approximate USD basis from
the recovered SOL input amount and current SOL/USD. If history is unavailable or
pruned, recovery falls back to the current token market price and labels the
basis as approximate.

## Live execution journal

**File:** `src/execution/liveExecutionJournal.ts`

Every live open and close is written to `live_execution_journal` before the swap
is submitted. The journal advances through:

```text
prepared -> submitted -> confirmed -> persisted
```

Pre-submission errors become `failed`. Errors after submission remain
`submitted`, and errors after confirmation remain `confirmed`, because RPC
uncertainty must not be mistaken for on-chain failure.

`saveOpenPosition` and `saveClosedTrade` mark matching journal rows `persisted`
inside the same SQLite transaction as the position/trade write. Live startup
blocks when submitted or confirmed rows remain incomplete, and directs the
operator to `recover-positions` before new risk is opened.

`journal` lists blocking rows. `journal-resolve <id>` queries Solana RPC and only
marks a submitted row failed when the signature has an on-chain error or its
Jupiter validity window is provably expired. Confirmed or still-unknown
transactions cannot be dismissed through this command.

---

## Analytics and reporting

For the owner/operator go-live checklist, see
[`docs/go-live-runbook.md`](go-live-runbook.md).

### During `run`

| Log prefix | Content |
|---|---|
| `[trade] OPENED ...` | Strategy, score, entry price (+ tx signature in live mode) |
| `[trade] CLOSED ...` | Reason, P&L ($, %), hold time (+ tx signature in live mode) |
| `[cycle] ...` | Events processed, opened, closed, open count, cash |
| `[analytics] ...` | Full stats output every N passes (`--analytics-every`, default 10) |
| `[run:process] ...` | Raw enrichment / scoring counts |
| `[run:exits] ...` | Raw exit counts, including `failed=` for live tx errors |
| `[run:exits:fast] ...` | Activity-triggered exit pass results |
| `[reconcile] ...` | Startup wallet reconciliation results |

### CLI commands

| Command | Purpose |
|---|---|
| `run` | Main loop. `mode: live` enables on-chain swaps. `--exit-interval-seconds` (default 10 in live). |
| `live-readiness` | Audit live prerequisites, confirmation/impact policy, and sizing without reading wallet contents or placing trades. |
| `wallet-balances` | Read live wallet SOL/USDC/USDT route-input balances and SOL fee reserve status without placing trades. |
| `recover-positions` | Resolve wallet/SQLite discrepancies. `--dry-run`, `--yes`. |
| `journal` | List submitted or confirmed live executions that still require reconciliation. |
| `journal-resolve` | Resolve an RPC-proven failed or expired submitted execution. |
| `report` | Persisted scores, open positions, closed trades, events. |
| `stats` | Trade analytics: expectancy, win rate, P&L by strategy / reason / score bucket / source. |
| `strategies` | Compact per-strategy performance summary. |
| `outcomes` | Counterfactual MFE/MAE by score bucket. |
| `tune` | Outcome data → threshold recommendations plus risk-signal calibration notes. `--apply` (`--yes`) only writes concrete config thresholds. |
| `pump-watch` | Bounded PumpPortal listener. |
| `pump-process` | Process pending events into scored candidates. |
| `manage-exits` | One-shot exit pass. |
| `track-outcomes` | One-shot forward price capture. |
| `prune` | Delete old untraded scored candidates. |
| `check-route` | Read-only Jupiter route smoke test. |

---

## Data pipeline — detailed

### PumpPortal WebSocket
Subscribes to `subscribeNewToken` and `subscribeMigration` free streams. Events are persisted immediately, processed asynchronously. Events with no market data remain `pending` and are retried up to 5 times.

### Enrichment
DexScreener (`/tokens/<mints>`) and Raydium pool endpoint queried in parallel per mint. Results merged: price/liquidity/pair from the deepest pool; volume/buy-sell counts/momentum from DexScreener. Retry-refreshed candidates get a fresh route check before opening.

### Jupiter route check
1. Quotes a small fixed buy (SOL→token, USDC→token, USDT→token) — keeps lowest-slippage route
2. Probes a $5 ExactOut sell (token→USDC) — `sellRouteAvailable: false` = honeypot, −50 pts

---

## SQLite schema

**`scored_candidates`**
```
id, chain, address, symbol, strategy_id, token_json, score, recommendation,
reasons, risks, source, price_usd, liquidity_usd, volume_5m_usd,
route_available, sell_route_available, estimated_slippage_bps,
mint_authority_revoked, freeze_authority_revoked, top5_holder_pct,
volume_acceleration_5m_z, volume_acceleration_samples,
outcome_high_usd, outcome_low_usd, outcome_last_usd,
outcome_first_take_profit_at, outcome_first_stop_loss_at,
outcome_done, created_at
```

**`open_positions`**
```
id, chain, address, symbol, strategy_id, token_json, score,
entry_price_usd, quantity, opened_at, high_water_mark_usd, last_mark_usd,
entry_tx_signature, entry_network_fee_lamports, entry_network_fee_usd  ← live mode only
```

**`closed_trades`**
```
id, position_id, chain, address, symbol, strategy_id, token_json, score, source,
entry_price_usd, exit_price_usd, quantity, reason, exit_price_source,
pnl_usd, pnl_pct, opened_at, closed_at,
exit_tx_signature, entry_network_fee_lamports, exit_network_fee_lamports,
entry_network_fee_usd, exit_network_fee_usd  ← live mode only
```

**`token_volume_snapshots`** — per-token 5m volume history for acceleration signal

**`pumpportal_events`** — raw WebSocket events with processing status

**`live_execution_journal`** — live swap intent, signature, state, and audit history

---

## Configuration reference

```yaml
mode: paper  # 'paper' | 'live'

chains:
  solana:
    enabled: true
    walletFile: ./wallet/chain-solana.txt   # live mode only — Solana CLI keypair JSON
    rpcUrlEnv: SOLANA_RPC_URL               # env var name for RPC URL (also used for risk signals)
    minLiquidityUsd: 10000
    minVolume5mUsd: 5000
    maxSlippageBps: 500
    maxPriceImpactBps: 500              # optional; defaults to maxSlippageBps
    priorityFeeLamports: auto               # live mode: lamports per tx, or 'auto' (Jupiter dynamic)
    confirmationCommitment: confirmed       # 'confirmed' for lower latency, 'finalized' for stronger finality

paper:                                      # controls position sizing in both paper and live modes
  startingBalanceUsd: 1000
  positionSizeUsd: 25                       # base size, scaled by strategy conviction tiers
  maxOpenPositions: 3
  maxDailyLossUsd: 100                      # circuit breaker; resets at UTC midnight

exits:                                      # global defaults; each strategy may override
  stopLossPct: 20
  takeProfitPct: 300                        # safety ceiling — trailing stop is the real exit
  trailingStopPct: 15
  trailingArmPct: 30
  maxHoldMinutes: 60

fees:
  swapFeeBps: 30
  applyRouteSlippage: true

scoring:
  minimumScoreToEnter: 75

strategies:
  freshLaunchMomentum:
    minScoreToEnter: 75
    exits:
      trailingArmPct: 30
      trailingStopPct: 15
      maxHoldMinutes: 60
      takeProfitPct: 300
  migrationMomentum:
    minScoreToEnter: 70
    exits:
      stopLossPct: 18
      trailingArmPct: 15
      trailingStopPct: 12
      maxHoldMinutes: 25
      takeProfitPct: 200

retention:
  scoredCandidateDays: 30
```

---

## File map

```
src/
  cli/index.ts                        CLI entrypoint: all commands

  config/schema.ts                    Zod config schema (ChainConfig, BotConfig)
  config/loadConfig.ts                YAML loader

  strategies/types.ts                 TradingStrategy interface + StrategyConfig
  strategies/freshLaunchMomentum.ts   Fresh launch strategy + scorer
  strategies/migrationMomentum.ts     Migration strategy + scorer
  strategies/buildStrategies.ts       Config → strategy array factory

  execution/broker.ts                 ExecutionBroker interface (paper/live seam)
  execution/brokerFactory.ts          createExecutionBroker factory
  execution/liveBroker.ts             LiveBroker — on-chain Jupiter swap execution
  execution/liveExecutionJournal.ts   Persistent execution journal types/reporting
  execution/liveDeps.ts               Production deps: keypair, sign/send, confirm, decimals
  execution/jupiterSwap.ts            Jupiter quote + swap transaction API
  execution/solanaConfirmation.ts     Block-height-aware confirmation policy
  execution/solanaTransactionFill.ts  Confirmed transaction balance-delta fill parser
  execution/liveReadiness.ts          live-readiness audit logic
  execution/tokenActivityWatcher.ts   Solana RPC logsSubscribe WebSocket watcher
  execution/walletReconciler.ts       On-chain vs SQLite position reconciliation
  execution/positionRecovery.ts       Pure recovery transforms for recover-positions
  execution/solanaTransactionHistory.ts Recent wallet buy lookup for orphan recovery

  paper/paperBroker.ts                PaperBroker (implements ExecutionBroker)
  paper/restoreBroker.ts              SQLite → PaperBroker state restoration

  scoring/scoreToken.ts               freshLaunchMomentum scorer

  bot/pumpProcess.ts                  Event → strategy routing → enrichment → entry
  bot/exitPositions.ts                Exit engine: re-price + two-phase trailing stop
  bot/retryBlockedOpens.ts            Retry capacity-blocked entries after exit pass
  bot/runLoop.ts                      Main loop: watch + process + exit + outcomes + watcher
  bot/volumeAcceleration.ts           Volume acceleration z-score computation
  bot/analytics.ts                    Trade and outcome analytics
  bot/reporter.ts                     Reporter interface + consoleReporter
  bot/tune.ts                         Threshold tuning recommendations
  bot/paperCycle.ts                   One-shot scan + paper-trade cycle
  bot/pumpWatch.ts                    Bounded PumpPortal listener
  bot/trackOutcomes.ts                Forward MFE/MAE capture
  bot/pumpCandidates.ts               fetchPumpPortalMarketCandidates (DexScreener + Raydium)
  bot/storageReport.ts                Persisted state report renderer
  bot/report.ts                       In-memory scan report renderer

  chains/solana/scanner.ts            DexScreener-based Solana scan
  chains/solana/mintAuthority.ts      Solana RPC mint/freeze authority check
  chains/solana/holderConcentration.ts Top-5 holder concentration check

  discovery/dexscreener.ts            DexScreener pair discovery
  discovery/jupiter.ts                Jupiter route check + sell probe + exit slippage
  discovery/pumpPortal.ts             PumpPortal WebSocket client
  discovery/raydium.ts                Raydium pool/liquidity enrichment

  storage/sqliteStore.ts              SQLite schema (auto-migrating), repositories
  types/domain.ts                     Shared types: TokenCandidate, PaperPosition, PaperTrade
```

---

## Development

```bash
npm install
npm test              # 38 test files, 290 tests
npm run typecheck     # must be clean before committing
npm run bot -- --help # show all commands
```

**Before running live:**
```bash
npm run bot -- live-readiness   # audit all prerequisites
npm run bot -- wallet-balances  # verify route-input inventory and SOL fee reserve
npm run bot -- recover-positions --dry-run  # verify wallet/SQLite sync
```

Live opens enforce the configured SOL fee reserve before quote/sign/submit and
skip SOL-funded buy routes that would spend below it. This prevents avoidable
entry failures without blocking exits or recovery.

**Never commit:** `wallet/`, `.env`, `data/`, `logs/`, `node_modules/`
**Never log:** private keys, seed phrases, API keys
