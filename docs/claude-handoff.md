# Claude Handoff — Strategy, Execution & Reporting Architecture

**Last updated:** 2026-06-02 · **Branch:** `feature/strategy-interface-and-analytics`
**Reviewer:** Codex. Counterpart: `docs/codex-handoff.md`.

Paper-only. Do not introduce live wallet/private-key use.

---

## Current health

```
npm test          → 23 files, 134 tests passing
npm run typecheck → clean
```

---

## Everything built on this branch

This branch covers two Claude sessions. All 11 commits sit on top of `development` (PR #9).

### Session 1 — Architecture foundation

| Commit | What |
|---|---|
| `TradingStrategy` interface + `byStrategy` analytics | Typed strategy interface with `id`, `config`, `tagCandidate`, `scoreCandidate`, `acceptsEventType`, `resolvePositionSizeUsd`. `AnalyticsTrade` gains `strategyId`; analytics report leads with `By strategy` section. |
| `ExecutionBroker` interface | `src/execution/broker.ts` — the typed contract a live broker must satisfy. `PaperBroker implements ExecutionBroker` with `mode = 'paper'`. The seam for paper→live swap. |
| `StrategyConfig` on each strategy | Each strategy carries `minScoreToEnter` and optional `exits` overrides. CLI builds strategies from config file values. |
| `Reporter` interface + `consoleReporter` | `onPositionOpened` / `onPositionClosed` / `onCycleSummary` event hooks. Emits `[trade]` and `[cycle]` lines during `run`. |
| Config schema: `mode: 'paper' \| 'live'` | CLI guards `live` with a clear error. `notifications.console` flag. |
| Storage report: `strat=` on every row | Positions and closed trades now show which strategy produced them. |
| `strategies` CLI command | Per-strategy table: trades, win%, P&L, expectancy, profit factor, hold time. |
| Scoring owned by strategy | `strategy.scoreCandidate()` replaces global scorer call in `pumpProcess`. A second strategy can weight signals differently. |
| Strategy exit overrides | `resolveExits` in `processExits` merges strategy-specific exit thresholds over globals per position. |
| Periodic analytics during `run` | Every N passes (default 10, `--analytics-every` flag) emits the full `stats` output inline. |
| Solana mint/freeze authority screening | `src/chains/solana/mintAuthority.ts` — read-only RPC `getAccountInfo`. mintAuthority held → -20 pts; freezeAuthority held → -15 pts. Both revoked → bonus. Best-effort; pipeline never blocked by RPC failure. |

### Session 2 — Strategy differentiation and feedback loop

| Commit | What |
|---|---|
| Two-phase trailing stop | `trailingArmPct` added to `ExitRules`. Phase 1 (below threshold): only hard stop-loss. Phase 2 (HWM ≥ arm threshold): trailing stop takes over. Fixed TP raised to 300% as a safety ceiling, not the real exit. Config: arm=30%, trail=15%, hold=60 min. |
| MigrationMomentum strategy | `src/strategies/migrationMomentum.ts` — independent scorer for `migration` events. Weights liquidity heavily (bonding curve completion = proven demand), forgives age (30min–6h window), uses tighter exits (arm=15%, trail=12%, hold=25 min, SL=18%). `minScoreToEnter: 70`. |
| Event routing | `TradingStrategy.acceptsEventType()`. `new_token` → freshLaunchMomentum; `migration` → migrationMomentum. Pipeline routes per event; falls back to first strategy. |
| Conviction-based sizing | `TradingStrategy.resolvePositionSizeUsd(score, base)`. Fresh launch: 90+→1.5x, 80-89→1.0x, 75-79→0.75x. Migration: 85+→1.25x. `PaperBroker.openPosition` accepts optional size override. |
| `tune` command | `src/bot/tune.ts` + CLI command. Reads MFE/MAE outcome data, emits confidence-rated recommendations: when to raise/lower entry threshold, when fixed TP is cutting winners short, when stop-loss could tighten. Closes the `track-outcomes` → `tune` → config feedback loop. |

---

## Architecture: paper → live transition path

The `ExecutionBroker` interface is the seam. The entire bot pipeline (`pumpProcess`, `exitPositions`, `runLoop`) speaks to the interface, not to `PaperBroker` directly.

To add live trading:
1. Implement `LiveBroker implements ExecutionBroker` in `src/execution/liveBroker.ts`
2. `openPosition()` → submit Jupiter swap transaction, sign with wallet keypair from `chainConfig.walletFile`
3. `closePosition()` → submit sell transaction
4. CLI `run`: branch on `config.mode === 'live'`, instantiate `LiveBroker` instead of `PaperBroker.restore()`
5. `LiveBroker` reads open positions from the chain, not from SQLite (but still writes to SQLite for reporting/analytics)

---

## Active strategies

### freshLaunchMomentum
- **Edge:** Small fraction of new Pump.fun tokens sustain buy pressure through the first hour. Can move 200-1000%.
- **Entry events:** `new_token` only
- **Entry threshold:** score ≥ 75 (configurable via `scoring.minimumScoreToEnter`)
- **Sizing:** 90+→1.5x, 80-89→1.0x, 75-79→0.75x base size
- **Exits:** SL=20%, arm at +30%, trail at 15% from peak, hold max 60 min

### migrationMomentum
- **Edge:** Bonding curve completion executes a large structural buy that seeds Raydium. Token proved demand through price discovery on Pump.fun. Migration pump is typically sharp and short.
- **Entry events:** `migration` only
- **Entry threshold:** score ≥ 70
- **Sizing:** 85+→1.25x, below→1.0x base size
- **Exits:** SL=18%, arm at +15%, trail at 12% from peak, hold max 25 min

---

## CLI commands reference

| Command | Purpose |
|---|---|
| `run` | Main loop: watch PumpPortal, process events, exit positions, track outcomes |
| `report` | Persisted scores, positions (with strat=), trades (with strat=), events |
| `stats` | Full analytics: overall + by strategy, reason, score bucket, source |
| `strategies` | Compact per-strategy P&L table |
| `outcomes` | Candidate MFE/MAE counterfactual by score bucket |
| `tune` | Outcome data → specific threshold recommendations with confidence ratings |
| `pump-watch` | Bounded PumpPortal listener |
| `pump-process` | Process pending events into scored candidates |
| `manage-exits` | One-shot exit pass on open positions |
| `track-outcomes` | One-shot forward price capture for scored candidates |
| `prune` | Delete old untraded scored candidates |
| `check-route` | Read-only Jupiter route smoke test |

---

## Remaining open items

### Highest priority

**DB columns for authority flags**
`mintAuthorityRevoked` and `freezeAuthorityRevoked` are stored in the `token_json` blob today. Adding dedicated columns to `scored_candidates` enables direct SQL queries: "how many scored candidates had held mint authority, and did they perform worse?" The migration is a single `addColumnIfMissing` call each.

**Volume acceleration signal**
Currently `volume5mUsd` and `volume1hUsd` are point-in-time snapshots. The edge for both strategies is *acceleration* — is volume increasing relative to its own recent rate? This requires storing per-token volume history (one row per scoring pass). The scoring function can then compute a z-score: "this 5m volume is 3 standard deviations above the token's own 30-minute rolling average." Not buildable without the data model first.

**Strategy exit overrides wired into `manage-exits` CLI command**
The `run` loop uses `resolveExits` correctly. The standalone `manage-exits` command still passes only global exits. Should build `buildExitResolver` from the active strategies there too.

### Medium priority

**Multiple strategies in `retryBlockedOpens`**
Retry currently uses the minimum threshold across all strategies. It doesn't know which strategy owns each retriable candidate, so it can't apply strategy-specific thresholds to retries. Requires storing `strategy_id` on `scored_candidates` as a real queryable column (same migration as authority flags above).

**Tune recommendations auto-apply**
`tune` currently prints recommendations. A `--apply` flag could write the suggested values directly to `config.yaml` with a confirmation prompt.

**Holder concentration check**
On-chain RPC read of the token's top accounts (SPL `getTokenLargestAccounts`). If top 5 wallets hold >80% of supply, it's a rug risk regardless of other signals. Same pattern as the mint authority check.

### Live trading (after paper is validated)

1. `LiveBroker implements ExecutionBroker` — Jupiter swap submission + keypair signing
2. Real-time exit triggers — WebSocket price feeds rather than interval polling
3. Base paper support — after Solana paper results are confirmed meaningful

### Minor

- Retry uses scored price, not re-fetched price (acceptable for paper)

---

## Safe continuation checklist

```bash
npm test
npm run typecheck
git diff --check
```

If behavior changes beyond metadata/config, add a focused test proving old paper trading behavior is preserved or documenting the new behavior explicitly.
