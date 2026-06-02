# Claude Handoff — Strategy Abstraction Foundation

**Last updated:** 2026-06-01 · **Branch:** `feature/strategy-abstraction`
**Reviewer:** Codex. Counterpart: `docs/codex-handoff.md`.

This is the current handoff for Claude to continue from Codex's first strategy-abstraction slice.
The bot is still **paper-only** and **Solana-first**. Do not introduce live wallet/private-key use.

---

## Current state

Recent landed work on `development` before this branch:

1. **PR #5 — trading blockers + paper-fill realism** (`feature-claude-review`).
2. **PR #6 — analytics, outcome capture, retention** (`feature-scrutinize`).
3. **PR #7 — path-dependent outcome thresholds** (`feature/outcome-path-order`).
4. **PR #8 / Claude Session 4 — rug screening + capacity retry** (`claude-next-steps`).
5. **Codex docs refresh** — `docs/codex-handoff.md` was refreshed on `development` after PR #8.

Current branch work:

6. **Codex strategy-abstraction foundation** — branch `feature/strategy-abstraction`, commit
   `c4cd813 feat: tag trades with fresh launch strategy`.

**Health on current branch:**

```text
npm test          -> 20 files, 104 tests passing
npm run typecheck -> clean
```

---

## What Codex just changed on `feature/strategy-abstraction`

The first multi-strategy foundation slice is implemented and pushed.

### Strategy identity module

Created:

- `src/strategies/freshLaunchMomentum.ts`

Exports:

- `FRESH_LAUNCH_MOMENTUM_STRATEGY_ID = 'freshLaunchMomentum'`
- `tagFreshLaunchMomentum(candidate)`

Purpose: keep the existing launch-token strategy explicitly named instead of having implicit
strategy behavior scattered through discovery/scoring/paper trading.

### Domain type

Modified:

- `src/types/domain.ts`

`TokenCandidate` now has optional `strategyId?: string`.

Notes:

- Raw discovery candidates may omit `strategyId`.
- Strategy-processed candidates should carry it.
- Current PumpPortal flow tags candidates as `freshLaunchMomentum`.

### PumpPortal processing

Modified:

- `src/bot/pumpProcess.ts`

Behavior:

- Enriched PumpPortal candidates are tagged through `tagFreshLaunchMomentum()`.
- Paper positions opened from those candidates inherit `token.strategyId`.

### SQLite persistence and migrations

Modified:

- `src/storage/sqliteStore.ts`

Added `strategy_id TEXT NOT NULL DEFAULT 'freshLaunchMomentum'` to:

- `scored_candidates`
- `open_positions`
- `closed_trades`

Migration/backfill behavior:

- Existing DBs get the columns via `addColumnIfMissing`.
- Legacy rows default to `freshLaunchMomentum`.

Read/write behavior now preserves or projects `strategyId` through:

- scored candidate inserts/listing
- open position save/restore/listing
- closed trade recording/listing
- closed-trade analytics summaries

### Tests

Modified:

- `tests/pumpProcess.test.ts`
- `tests/sqliteStore.test.ts`

Coverage added/updated for:

- PumpPortal candidates and opened positions receiving `freshLaunchMomentum`.
- scored candidates preserving `strategyId`.
- open positions restoring `strategyId`.
- closed trades and closed-trade analytics preserving `strategyId`.

---

## Why this matters

The bot currently has one implicit strategy: fresh launch momentum from PumpPortal/Dex-style token
flow. Before adding Base/EVM support, on-chain risk checks, or alternate tactics, results need to
be attributable to a specific strategy. This branch creates that attribution path without changing
trading behavior.

The next Claude pass should extend this from a label into a real strategy abstraction/config layer,
but should keep scope tight and paper-safe.

---

## Plan moving forward for Claude

Recommended implementation order. Keep each step test-first where practical and commit in small
slices.

### Task 1 — Review current branch before editing

**Objective:** Confirm the current strategy-id plumbing is correct and no behavior changed besides
metadata attribution.

**Files to inspect:**

- `src/strategies/freshLaunchMomentum.ts`
- `src/bot/pumpProcess.ts`
- `src/storage/sqliteStore.ts`
- `src/types/domain.ts`
- `tests/pumpProcess.test.ts`
- `tests/sqliteStore.test.ts`

**Commands:**

```bash
git status --short --branch
git log --oneline -5
npm test
npm run typecheck
```

**Expected:** clean working tree, current branch `feature/strategy-abstraction`, tests/typecheck
pass.

### Task 2 — Introduce a minimal strategy interface

**Objective:** Define a small interface for strategy identity and candidate preparation without
rewriting the bot around plugins yet.

**Suggested files:**

- Create: `src/strategies/types.ts`
- Modify: `src/strategies/freshLaunchMomentum.ts`

**Suggested shape:**

```ts
import type { TokenCandidate } from '../types/domain.js';

export interface TradingStrategy {
  id: string;
  tagCandidate(candidate: TokenCandidate): TokenCandidate;
}
```

Then make `freshLaunchMomentum` export a concrete strategy object:

```ts
export const freshLaunchMomentumStrategy: TradingStrategy = {
  id: FRESH_LAUNCH_MOMENTUM_STRATEGY_ID,
  tagCandidate: tagFreshLaunchMomentum,
};
```

**Tests:** Add a small strategy unit test if useful, or extend existing PumpPortal tests to assert
`freshLaunchMomentumStrategy.id` is used rather than a duplicated string.

### Task 3 — Route PumpPortal through the strategy object

**Objective:** Replace direct helper usage in `pumpProcess.ts` with the strategy object so the
current flow resembles a future multi-strategy flow.

**Suggested files:**

- Modify: `src/bot/pumpProcess.ts`
- Test: `tests/pumpProcess.test.ts`

**Expected behavior:** unchanged except implementation uses `freshLaunchMomentumStrategy`.

**Verification:**

```bash
npm test -- tests/pumpProcess.test.ts
npm run typecheck
```

### Task 4 — Add strategy-aware analytics/report grouping

**Objective:** Make the new `strategy_id` visible enough to be useful.

**Suggested files to inspect/modify:**

- `src/storage/sqliteStore.ts`
- report/CLI files under `src/cli/` or wherever report rendering currently lives
- existing report tests, if present

**Possible output changes:**

- closed-trade analytics grouped by strategy, or
- strategy column in existing closed-trade/stat lines, or
- optional per-strategy summary section.

**Important:** Do not overbuild dashboards. The immediate goal is to let a paper run answer:
"How did `freshLaunchMomentum` perform?" and later compare it with another strategy.

### Task 5 — Add strategy config boundaries without adding new strategies yet

**Objective:** Separate strategy-specific knobs from generic bot/runtime config only where current
code already has fresh-launch-specific assumptions.

**Candidate fields to identify:**

- scoring threshold / max open decisions if they are strategy-specific
- candidate age / trade horizon assumptions
- risk penalties tied to fresh launches

**Non-goals for this task:**

- Do not add Base live trading.
- Do not add wallet use.
- Do not add a full plugin registry.
- Do not add multiple simultaneous strategy execution unless the current config boundary is already
  clean and tests make it obvious.

### Task 6 — Then resume risk-screening work

Once strategy attribution/config is stable, the next highest-value product work remains:

1. **Solana mint/freeze authority checks**
   - Add Solana RPC account inspection.
   - Persist/report risk flags.
   - Penalize or reject candidates with unsafe authority status.
2. **Longer paper run inspection**
   - Run paper session.
   - Inspect report/outcomes by strategy.
   - Tune scoring/exits from observed data.
3. **Base paper support, disabled by default**
   - Only after Solana paper flow is stable and strategy attribution is visible.

---

## Known remaining items

Resolved previously:

- ~~path-dependent outcome win/loss labeling~~ (PR #7)
- ~~ambiguous vs unknown outcome classification~~ (Claude Session 4 / PR #8)
- ~~capacity-blocked candidates not retried~~ (Claude Session 4 / PR #8)
- ~~initial strategy attribution path missing~~ (this branch)

Still open:

1. **Strategy abstraction is only partially done** — current branch tags existing behavior but does
   not yet provide a full strategy interface/config boundary.
2. **On-chain mint/freeze authority check** — sell-route screening catches many honeypot/no-sell
   cases, but mint/freeze authority still require Solana RPC checks.
3. **Retry uses scored price, not re-fetched price** — acceptable for paper within the horizon
   window; should be re-quoted/re-checked before live.
4. **Retry cooldown semantics** — recent-closed guard currently uses trade horizon
   (`maxHoldMinutes`); product decision needed on a dedicated cooldown.
5. **Migrate-time `closed_trades` dedup runs on every startup** — negligible for paper.
6. **Package name** still `hermes-agent` in `package.json` — cosmetic.
7. **No live trading** — paper-only by design.
8. **Exits only fire on the process interval** — accepted for paper; live needs real-time triggers or
   tighter monitoring.
9. **Outcome-tracking selection bias** — unpriceable candidates are not sampled, so MFE/MAE skews
   toward names that stayed liquid.

---

## Suggested Claude review focus

Before implementing the next slice, please scrutinize:

- Are the SQLite defaults/backfills for `strategy_id` safe for existing paper DBs?
- Should `strategyId` remain optional on raw `TokenCandidate`, or should discovery produce a
  separate raw-candidate type and strategy output be required to include `strategyId`?
- Should strategy attribution live on the token JSON, the table column, or both? Current branch does
  both for compatibility and queryability.
- Is `freshLaunchMomentum` the right stable ID string for reports/analytics? If renamed, migrate now
  before more paper data accumulates.
- What is the smallest useful strategy interface that avoids premature plugin architecture?

---

## Safe continuation checklist

Run before handing back or opening/merging a PR:

```bash
npm test
npm run typecheck
git diff --check
```

If behavior changes beyond metadata/config boundaries, add a focused test that proves the old paper
trading behavior is preserved or explicitly documents the new behavior.
