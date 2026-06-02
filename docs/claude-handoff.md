# Claude Handoff — Strategy, Execution & Reporting Architecture

**Last updated:** 2026-06-02 · **Branch:** `codex/volume-acceleration-signal`
**Reviewer:** Codex. Counterpart: `docs/codex-handoff.md`.

Paper-only. Do not introduce live wallet/private-key use.

---

## Current health

```
npm test          → 26 files, 163 tests passing
npm run typecheck → clean
git diff --check  → clean
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

### Codex continuation — next-step implementation

Built on `development` after PR #10 merge, on branch `codex/claude-handoff-next-steps`.

| Commit | What |
|---|---|
| `f4c115f` Add strategy metadata storage and retry wiring | Added queryable `mint_authority_revoked`, `freeze_authority_revoked`, and `top5_holder_pct`-ready plumbing to scored candidate projections; added `token_volume_snapshots` history table written on every score save; made retry strategy-aware using SQL-side per-strategy thresholds before `LIMIT`; preserved strategy/authority metadata on retried opens; wired `manage-exits` to `buildExitResolver`. |
| `3e99a44` Add tune apply support | Added `tune --apply` with confirmation prompt and `--yes` for non-interactive use. Applies only concrete numeric recommendations to YAML config; skips ambiguous suggestions such as `Raise to 200-300`. |
| `6ca2c20` Add Solana holder concentration risk check | Added read-only `getTokenLargestAccounts` + `getTokenSupply` RPC check in `src/chains/solana/holderConcentration.ts`; enriches PumpPortal candidates with `top5HolderPct`; persists `top5_holder_pct`; penalizes both strategies when top five holders own ≥80% of supply. Best-effort: RPC failure leaves the signal unknown and does not block processing. |
| `3dac574` Rename package to crypto-bot | Renamed package metadata from `hermes-agent` to `crypto-bot`; left CLI binary as `hermes-paper-bot`; cleaned stale handoff notes. |

### Codex continuation — volume acceleration

Built on updated `development` after the prior Codex branch was merged/pulled, on branch `codex/volume-acceleration-signal`.

| Commit | What |
|---|---|
| `585e986` Add volume acceleration scoring signal | Added `src/bot/volumeAcceleration.ts` to compute current 5m volume against recent per-token baseline snapshots. `pumpProcess` reads the last 30 minutes from `token_volume_snapshots` before saving the current score, attaches `volumeAcceleration5mZ` and `volumeAccelerationSamples`, and both active strategies add modest bonuses for z≥1/z≥2 or a risk for sharp deceleration. `scored_candidates` now persists `volume_acceleration_5m_z` and `volume_acceleration_samples`; retry preserves the fields. No-history behavior is unchanged. |
| `2577d69` Add signal buckets to outcome analytics | `outcomes` now groups MFE/MAE by authority status, holder concentration, and volume acceleration buckets. `loadScoredOutcomeStats()` projects the persisted signal columns so the report can validate whether held authorities, high top-five concentration, or acceleration/deceleration correlate with paper outcomes. |
| `37d3e60` Add strategy-specific tune reporting | `tune` still prints the global calibration view, then adds per-strategy sections using each active strategy's own entry threshold. Outcome rows now carry `strategyId`, and score buckets were split into `<70`, `70-74`, `75-79`, `80-89`, `90-100` so migration's 70 threshold is tunable. `--apply` remains conservative and only writes concrete global config updates. |
| `4f4ebb6` Add live readiness audit | Added `live-readiness` CLI command and pure `evaluateLiveReadiness()` audit. It checks live blockers/prereqs without reading wallet contents or placing trades: missing LiveBroker, mode gate, Solana enabled, RPC env, wallet-file presence, sizing/loss-limit sanity, paper cost model, closed trade sample, and tracked outcome sample. Paper sample counts are advisory calibration warnings, not owner-permission gates. |
| `23cf9ea` Make paper validation advisory for live readiness | Changed `live-readiness` so low paper-trade sample counts warn but do not block readiness. The owner should be able to switch between paper and live; paper results inform calibration rather than acting as training-wheel enforcement. |
| `ebc0c59` Refresh retry candidates before opening | Retry opens now optionally refresh market data before opening. The run loop re-fetches the candidate and Jupiter route/sellability; if no current market data is found, it skips the retry instead of opening from stale scored price. |

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
| `tune` | Outcome data → specific threshold recommendations with confidence ratings. `--apply` writes concrete numeric suggestions after confirmation; `--yes` skips confirmation. |
| `live-readiness` | Audits live-trading prerequisites without reading wallet contents, signing, or placing trades |
| `pump-watch` | Bounded PumpPortal listener |
| `pump-process` | Process pending events into scored candidates |
| `manage-exits` | One-shot exit pass on open positions |
| `track-outcomes` | One-shot forward price capture for scored candidates |
| `prune` | Delete old untraded scored candidates |
| `check-route` | Read-only Jupiter route smoke test |

---

## Remaining open items

### Highest priority

Keep the paper/live mode switch seamless for the owner. `live-readiness` should report mechanical blockers and advisory calibration warnings, but it must not force a minimum number of paper cycles before the owner can choose live mode. The current hard blocker is the intentionally missing `LiveBroker`.

### Medium priority

**Volume acceleration analytics/tuning**
The signal is implemented, persisted, and reported by outcome bucket. Next useful step is to collect enough paper data, then tune the current z-score thresholds/weights from observed MFE/MAE.

**Tune apply UX**
`tune` is strategy-aware for reporting. `tune --apply` still applies concrete global config recommendations only. Future work: add schema/config support for strategy-specific tunables before allowing per-strategy auto-apply.

**Risk-signal thresholds**
Holder concentration ≥80%, authority penalties, and volume acceleration weights are deliberately conservative defaults. Use the expanded `outcomes` report to validate and adjust them after enough tracked candidates accumulate.

### Live trading

1. `LiveBroker implements ExecutionBroker` — Jupiter swap submission + keypair signing
2. Real-time exit triggers — WebSocket price feeds rather than interval polling
3. Base paper support once Solana live/paper switching is clean

### Minor

- `docs/codex-handoff.md` was lightly cleaned for completed package-name work, but it has not been fully refreshed with the latest Codex commits.

---

## Resume notes for Codex

State at laptop-close handoff:
- Current branch: `codex/volume-acceleration-signal`
- Latest code commit before this handoff edit: `ebc0c59 Refresh retry candidates before opening`
- All verification passed after latest code commit:
  - `npm run typecheck`
  - `npm test` → 26 files, 163 tests passing
  - `git diff --check`
- Paper-only invariant is still intact. No wallet/private-key/live trading code was added.

Suggested next move:
1. Commit this handoff update after reviewing it.
2. Next practical work is schema/config support for strategy-specific tunables, or a LiveBroker scaffold that preserves the owner-controlled paper/live switch.
3. Paper results should inform calibration, not act as training-wheel enforcement.

---

## Safe continuation checklist

```bash
npm test
npm run typecheck
git diff --check
```

If behavior changes beyond metadata/config, add a focused test proving old paper trading behavior is preserved or documenting the new behavior explicitly.
