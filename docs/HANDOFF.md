# Handoff — Exit engine, broker rehydration, daily-loss breaker

**Author:** Claude Code · **Date:** 2026-05-31 · **Branch:** `development`
**Reviewer:** Codex (please review before further changes)

## Why this change

The bot could open paper positions but had **no way to close them**:

- `PaperBroker.closePosition()` was only ever called from tests.
- The `exits` config block and `paper.maxDailyLossUsd` were validated by the schema but read by no code.
- Every processing pass built a fresh `PaperBroker` with full starting cash and zero open positions, ignoring `open_positions` already in SQLite.

Net effect: `closed_trades` stayed empty forever, `report` PnL/win-rate were always zero, and after `maxOpenPositions` entries every new entry was blocked permanently. This change set implements the three coupled fixes that make paper-trading results actually materialize.

## What changed (by concern)

### 1. Exit engine — `src/bot/exitPositions.ts` (new)
- `decideExit(position, price, highWaterMarkUsd, exits, now)` — pure function, exit priority **take-profit > stop-loss > trailing-stop > timeout**.
- Trailing stop only arms once `highWaterMarkUsd > entryPrice`; it fires when price drops `trailingStopPct` below the peak.
- `processExits()` rehydrates the broker, re-prices open positions (DexScreener + Raydium via `fetchPumpPortalMarketCandidates`), closes triggered positions, persists raised high-water marks for the rest.
- **Deliberate choice:** positions with no fresh price are left open and retried next pass — never closed at a stale price. Documented limitation: a permanently unpriceable mint will not hit its `maxHoldMinutes` timeout.

### 2. Broker rehydration — `src/paper/paperBroker.ts`, `src/paper/restoreBroker.ts` (new), `src/storage/sqliteStore.ts`
- `PaperBroker.restore(options, state)` rebuilds cash, open positions, the daily-loss bucket, and the id sequence.
- **Cash is derived, not persisted:** `cash = startingBalance + realizedPnl − positionSize × openCount`. This holds because every open deducts exactly `positionSizeUsd` (quantity = size/price) and every close returns exit value. If `positionSizeUsd` ever becomes variable, this derivation breaks — flag for review.
- `restoreBrokerFromStore()` + `isBrokerStateStore()` adapt any store exposing the four read methods. Stores without them (unit-test fakes) fall back to a fresh broker, preserving old behavior.
- New `SqliteStore` methods: `loadOpenPositions`, `getRealizedPnlUsd`, `getRealizedPnlUsdSince`, `getNextPositionSeq`.
- New column `open_positions.high_water_mark_usd` (nullable; legacy rows fall back to entry price via `addColumnIfMissing`).
- `getNextPositionSeq()` scans **both** `open_positions` and `closed_trades` for the max `paper-N` so restored ids never collide.

### 3. Daily-loss breaker — `src/paper/paperBroker.ts`
- `maxDailyLossUsd` blocks new entries once the current **UTC day's** net realized PnL ≤ `-maxDailyLossUsd`.
- Bucketed by UTC day (`Map<dayKey, pnl>`), so it resets at the day boundary during a long `run`. **Exits are never blocked.**
- Surfaced via `canOpenPosition()`, which `openPosition()` enforces (and `pumpProcess` checks before attempting an entry).

### Wiring
- `src/bot/pumpProcess.ts`: rehydrates broker; a blocked entry is now marked `processed` with a `not opened (reason)` note instead of `failed`.
- `src/bot/runLoop.ts`: runs an exit pass each interval, guarded by `options.exits && isBrokerStateStore(store)`. New result field `closedPositions`.
- `src/cli/index.ts`: new `manage-exits` command (single exit pass); `run` and `pump-process` now thread `exits` + `maxDailyLossUsd`.
- `src/types/domain.ts`: `PaperPosition.highWaterMarkUsd` (required).

## Files

| New | Modified |
| --- | --- |
| `src/bot/exitPositions.ts` | `src/bot/pumpProcess.ts`, `src/bot/runLoop.ts`, `src/cli/index.ts` |
| `src/paper/restoreBroker.ts` | `src/paper/paperBroker.ts`, `src/storage/sqliteStore.ts`, `src/types/domain.ts` |
| `tests/exitPositions.test.ts` | `tests/paperBroker.test.ts`, `tests/runLoop.test.ts`, `tests/sqliteStore.test.ts` |
| `docs/HANDOFF.md` | `docs/system.md`, `README.md` |

## Verification

- `npm test` → **60 passed** (was 47; +13 new).
- `npm run typecheck` → clean.
- `npm run bot -- manage-exits` on an empty DB → `checked=0 ... closed=0` (no crash); command appears in `--help`.

## Review focus / open questions for Codex

1. **Cash derivation** assumes a constant `positionSizeUsd`. Acceptable? Or should cash be persisted explicitly?
2. **Exit pass shares the `run` process interval** (no separate `--exit-interval-seconds`). Re-pricing every process tick — fine, or should exits have their own cadence?
3. **Unpriceable positions never time out** (left open by design). Worth a fallback mark (e.g. last-known price) so `maxHoldMinutes` can still free the slot? Noted as next step in `docs/system.md`.
4. **Daily breaker uses UTC day** — confirm that's the desired boundary vs. a rolling 24h window.
5. `paperCycle.ts` (the one-shot `paper` command) still uses a fresh broker and was intentionally left out of rehydration — confirm that's acceptable for a single-cycle command.

## Not done (future steps, see `docs/system.md`)
- Per-source / score-bucket performance in `report`.
- Fallback exit price for unpriceable positions.
- Base paper support.
