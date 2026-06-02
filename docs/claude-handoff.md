# Claude Handoff — Strategy Interface & Execution Architecture

**Last updated:** 2026-06-02 · **Branch:** `feature/strategy-interface-and-analytics`
**Reviewer:** Codex. Counterpart: `docs/codex-handoff.md`.

This branch builds the multi-strategy / paper-to-live architecture foundation on top of the
strategy-id attribution from PR #9. Paper-only. Do not introduce live wallet/private-key use.

---

## Current state

Recent landed work before this branch:

1. **PR #5 — trading blockers + paper-fill realism** (`feature-claude-review`).
2. **PR #6 — analytics, outcome capture, retention** (`feature-scrutinize`).
3. **PR #7 — path-dependent outcome thresholds** (`feature/outcome-path-order`).
4. **PR #8 / Claude Session 4 — rug screening + capacity retry** (`claude-next-steps`).
5. **PR #9 — strategy-abstraction foundation** (`feature/strategy-abstraction`).

Current branch work (all 4 commits on `feature/strategy-interface-and-analytics`):

6. **TradingStrategy interface + byStrategy analytics** — `TradingStrategy` typed interface with
   `id`, `config`, `tagCandidate`, `scoreCandidate`. `AnalyticsTrade` gains `strategyId`;
   `TradeAnalytics` gains `byStrategy` bucket; analytics report leads with it.
7. **ExecutionBroker interface, StrategyConfig, Reporter** — `ExecutionBroker` contract for
   paper/live parity. `PaperBroker implements ExecutionBroker`. `StrategyConfig` carries
   `minScoreToEnter` + optional exit overrides per-strategy. `Reporter` interface with
   `consoleReporter` factory wired into pumpProcess, exitPositions, runLoop.
8. **Storage report + strategies command** — open positions and closed trades show `strat=` tag.
   New `strategies` CLI command: per-strategy trades / win% / P&L / expectancy / profit factor.
9. **Scoring owned by strategy** — `TradingStrategy.scoreCandidate()` method. `freshLaunchMomentum`
   delegates to `scoreTokenCandidate`. `pumpProcess` calls `strategy.scoreCandidate()`.

**Health on current branch:**

```text
npm test          -> 20 files, 104 tests passing
npm run typecheck -> clean
```

---

## What changed on this branch

### New files

| File | Purpose |
|---|---|
| `src/execution/broker.ts` | `ExecutionBroker` interface — the contract a live broker must implement |
| `src/bot/reporter.ts` | `Reporter` interface + `consoleReporter` factory for trade event hooks |

### Updated interfaces

**`src/strategies/types.ts`**

```ts
export interface TradingStrategy {
  id: string;
  config: StrategyConfig;           // minScoreToEnter + optional exit overrides
  tagCandidate(candidate): TokenCandidate;
  scoreCandidate(candidate): OpportunityScore;  // strategy-owned scoring
}
```

**`src/strategies/freshLaunchMomentum.ts`**

- `createFreshLaunchStrategy(config?)` factory — CLI builds it from file config.
- `freshLaunchMomentumStrategy` convenience singleton with default config.
- `scoreCandidate` delegates to `scoreTokenCandidate` (no behavior change).

**`src/config/schema.ts`**

- `mode: 'paper' | 'live'` (was `'paper'` literal). CLI guards `live` with helpful error.
- `notifications` section added: `console: boolean` flag + optional `telegram` stub.

**`src/paper/paperBroker.ts`**

- `implements ExecutionBroker` — compile-time check that the interface stays satisfied.
- `readonly mode = 'paper' as const`.

### Bot pipeline

- `pumpProcess.ts`: calls `freshLaunchMomentumStrategy.scoreCandidate()` (not global scorer).
  Accepts optional `reporter` param; fires `onPositionOpened` on each new position.
- `exitPositions.ts`: accepts optional `reporter` param; fires `onPositionClosed` on each exit.
- `runLoop.ts`: accepts optional `reporter`, passes it to sub-calls, emits `onCycleSummary`
  after every full pass (cash, open count, closed count, events processed).
- `storageReport.ts`: open positions and closed trades now show `strat=<id>`.

### CLI commands added/updated

| Command | Change |
|---|---|
| `run` | Uses `strategy.config.minScoreToEnter` (from config file). Builds `consoleReporter` when `notifications.console=true`. Errors on `mode: live`. |
| `stats` | Updated description to mention strategy breakdown. |
| `strategies` | **New.** Per-strategy table: trades, win%, P&L, expectancy, profit factor, hold. |

---

## Architecture for paper-to-live transition

The `ExecutionBroker` interface is the seam. When live trading is ready:

1. Implement `LiveBroker implements ExecutionBroker` in `src/execution/liveBroker.ts`.
2. `LiveBroker.openPosition()` submits a Jupiter swap transaction.
3. `LiveBroker.closePosition()` submits the sell.
4. `CLI run` branches on `config.mode === 'live'`: build `LiveBroker` instead of restoring a
   `PaperBroker`. The rest of the pipeline (`pumpProcess`, `exitPositions`, `runLoop`) is
   unchanged because they talk to `ExecutionBroker`, not a concrete class.

`PaperBroker` currently restores from SQLite state (`restoreBrokerFromStore`). `LiveBroker` would
use on-chain position state instead. The store still tracks everything for reporting and analytics.

---

## Remaining open items

### Strategy abstraction (almost complete)

- [ ] **Multiple strategies running simultaneously** — `pumpProcess` still hard-codes
  `freshLaunchMomentumStrategy`. When a second strategy is added, a strategy registry/router
  should select the strategy by token characteristics. Low priority until a second strategy exists.
- [ ] **Strategy exit overrides** — `StrategyConfig.exits` field exists but `exitPositions.ts`
  still reads global exits. Should merge `strategy.config.exits` over global when processing a
  position's owning strategy.

### Risk screening (still open)

- [ ] **Solana mint/freeze authority checks** — Solana RPC account inspection. Persist/report
  risk flags. Penalize or reject candidates with unsafe authority status.

### Reporting (next focus for user-facing value)

- [ ] **Telegram reporter** — implement `TelegramReporter implements Reporter` that posts trade
  events and cycle summaries to a configured Telegram bot. Config stub (`notifications.telegram`)
  is already in `config.yaml` waiting for it.
- [ ] **Periodic analytics summary during run** — emit the full `stats` output every N passes so
  long-running sessions are legible without stopping the bot.

### Live trading (after paper is stable)

- [ ] **`LiveBroker` implementation** — Jupiter swap submission + signing. Requires wallet load.
- [ ] **Real-time exit triggers** — current exits fire on the process interval. Live needs
  WebSocket price feeds or tighter polling for take-profit / stop-loss.
- [ ] **Base paper support** — only after Solana paper flow is stable and strategy attribution
  is confirmed correct.

### Minor

- [ ] **Package name** — still `hermes-agent` in `package.json`. Cosmetic.
- [ ] **Retry uses scored price, not re-fetched price** — acceptable for paper; must re-quote
  before live.

---

## Safe continuation checklist

```bash
npm test
npm run typecheck
git diff --check
```

If behavior changes beyond metadata/config boundaries, add a focused test proving the old paper
trading behavior is preserved or explicitly documenting the new behavior.
