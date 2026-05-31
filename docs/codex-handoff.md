# Codex Handoff: Paper Exit Lifecycle Hardening

## Branch and PR Target

- Working branch: `fix/paper-exit-lifecycle`
- Target branch: `development`
- Commit containing code fixes: `6bcf1b9 fix: harden paper exit lifecycle`

## Context

This change addresses lifecycle and accounting issues found during review of the paper-trading exit engine. The bot is still paper-only and Solana-first.

Primary goals:

1. Prevent the run loop from returning while an interval processing pass is still in flight.
2. Make persisted closed trades idempotent so duplicate close attempts do not double-count PnL.
3. Restore paper broker cash from actual persisted open-position value instead of current config size.
4. Make restored daily-loss breaker state deterministic with the caller-provided clock.
5. Ensure exit processing only runs when the store has both required read and write methods.

## Files Changed

### `src/bot/runLoop.ts`

- Added `canProcessExits()` guard.
- Exit processing now requires:
  - broker-state read methods via `isBrokerStateStore()`
  - `saveOpenPosition()`
  - `saveClosedTrade()`
- Reworked processing pass tracking:
  - interval passes now go through `startProcessPass()`
  - overlapping passes are still skipped
  - the currently active pass is retained as `activeProcess`
  - shutdown waits for `activeProcess` before closing the PumpPortal client and returning

Review focus:

- Confirm `activeProcess` cannot be cleared before the final `await` needs it.
- Confirm errors from interval processing are logged without bypassing cleanup.
- Confirm shutdown behavior is safe for both `durationMs` and `AbortSignal` stops.

### `src/storage/sqliteStore.ts`

- `saveClosedTrade()` now uses `INSERT OR IGNORE`.
- Migration now dedupes existing `closed_trades` rows by `position_id`, keeping the lowest `id`.
- Added unique index:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_closed_trades_position_id ON closed_trades(position_id);
```

Review focus:

- Confirm dedupe-before-index is safe for old SQLite DBs that may already have duplicates.
- Confirm `INSERT OR IGNORE` is the desired concurrency/idempotency behavior.
- Confirm ignoring duplicate close attempts is preferable to throwing in the CLI path.

### `src/paper/paperBroker.ts`

- `PaperBroker.restore()` cash reconstruction now uses:

```text
startingBalanceUsd + realizedPnlUsd - sum(open.entryPriceUsd * open.quantity)
```

instead of:

```text
startingBalanceUsd + realizedPnlUsd - positionSizeUsd * openCount
```

- Added optional `dailyRealizedPnlAt` to `PaperBrokerState`.
- Daily breaker restore now buckets restored daily PnL using `dailyRealizedPnlAt ?? new Date()`.

Review focus:

- Confirm cash restore is correct when `positionSizeUsd` changes while old positions remain open.
- Confirm the optional `dailyRealizedPnlAt` default preserves compatibility for direct test/helper callers.

### `src/paper/restoreBroker.ts`

- Passes the injected `now` into `PaperBroker.restore()` as `dailyRealizedPnlAt`.

Review focus:

- Confirm the day used for `getRealizedPnlUsdSince(startOfUtcDayIso(now))` matches the restored broker bucket.

### Tests

Updated/added tests in:

- `tests/runLoop.test.ts`
- `tests/sqliteStore.test.ts`
- `tests/paperBroker.test.ts`

New coverage includes:

- run loop waits for an in-flight interval pass before resolving on shutdown
- exits do not run when the store lacks exit write methods
- duplicate `saveClosedTrade()` calls for the same `positionId` are idempotent
- broker cash restore uses actual persisted open position value after config size changes
- daily-loss restore uses a deterministic day bucket

## Verification Performed

Targeted regression run:

```bash
npm test -- tests/runLoop.test.ts tests/sqliteStore.test.ts tests/paperBroker.test.ts
```

Result:

```text
3 test files passed
21 tests passed
```

Full suite, typecheck, and smoke command:

```bash
npm test && npm run typecheck && npm run bot -- manage-exits
```

Result:

```text
17 test files passed
64 tests passed
npm run typecheck passed
Exit pass complete. checked=0 repriced=0 closed=0 stopLoss=0 takeProfit=0 trailingStop=0 timeout=0 noPrice=0
```

## Known Remaining Items Not Addressed Here

These were intentionally left for later work:

1. Unpriceable positions still remain open indefinitely because timeout requires a fresh price.
2. Capacity-blocked candidates are still marked processed and are not retried after capacity frees.
3. Package metadata still uses the old `hermes-agent` name.
4. Live trading is still not implemented; this remains paper-only.

## Suggested Claude Review Checklist

- Look for race conditions in `runLoop.ts` around `activeProcess`, `processInFlight`, and shutdown cleanup.
- Evaluate whether `INSERT OR IGNORE` hides any important duplicate-close bug signals, or whether it is the right idempotency boundary.
- Check whether deduping old `closed_trades` rows by lowest `id` is the safest migration policy.
- Confirm broker cash math under multiple open positions with different historical entry sizes.
- Confirm TypeScript type changes are minimal and do not leak persistence-specific details into domain types unnecessarily.
