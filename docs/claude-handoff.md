# Claude Handoff — Paper Exit Lifecycle

**Last updated:** 2026-05-31 · **Branch:** `development`
**Reviewer:** Codex (review this doc after Claude sessions). Counterpart: `docs/codex-handoff.md`.

This is a living handoff. It is rewritten at the end of each Claude session to reflect the
**current** state of the paper-exit work, not a one-time changelog. The bot is paper-only,
Solana-first.

---

## Current state

The open → mark-to-market → exit lifecycle is implemented, hardened, and merged.

- Exit engine, broker rehydration, and the daily-loss breaker landed in `0655b6f` (Claude).
- Lifecycle/accounting hardening landed in `6bcf1b9` (Codex) and merged to `development` via PR #3 (`6a0551c`).
- Dedup regression test + handoff rename: `43d254c` (Claude).
- This session (Claude): implemented the unpriceable-position timeout (resolves prior known item #1).

**Health:** `npm test` → 67 passing · `npm run typecheck` → clean · `npm run bot -- manage-exits` smoke OK.

---

## Architecture recap (what exists today)

- **`src/bot/exitPositions.ts`** — `decideExit()` (pure) applies exit priority
  **take-profit > stop-loss > trailing-stop > timeout**. `processExits()` rehydrates the broker,
  re-prices open positions (DexScreener + Raydium), closes triggered ones, persists raised
  high-water marks for the rest. Unpriceable positions are left open and retried.
- **`src/paper/paperBroker.ts`** — `PaperBroker.restore()` rebuilds cash, open positions, the
  UTC-day daily-loss bucket, and the `paper-N` id sequence. Cash is **derived**, not persisted:
  `startingBalance + realizedPnl − sum(open.entryPriceUsd × quantity)`. `recordMark()` (replaces
  the old `updateHighWaterMark`) ratchets the high-water mark and always sets `lastMarkUsd`.
- **`src/paper/restoreBroker.ts`** — `restoreBrokerFromStore()` + `isBrokerStateStore()`; threads
  the caller's clock into the breaker bucket for determinism.
- **`src/storage/sqliteStore.ts`** — broker-state reads, `high_water_mark_usd` column,
  `INSERT OR IGNORE` + unique index on `closed_trades.position_id`, and a migrate-time dedup of
  legacy duplicate closes (keeps lowest id).
- **`src/bot/runLoop.ts`** — per-interval exit pass guarded by `canProcessExits()`; shutdown waits
  for the in-flight pass (`activeProcess`) before closing the client/store.
- **CLI** — `manage-exits` (single pass); `run` and `pump-process` thread `exits` + `maxDailyLossUsd`.

---

## Changes made this session (Claude)

### Implemented: unpriceable-position timeout (resolves prior item #1)

Previously a position with no fresh market data was skipped every pass, so a permanently
unpriceable mint held its slot forever — `maxHoldMinutes` could never fire without a price.

Fix: positions now carry a persisted **`lastMarkUsd`** (latest observed price; unlike the
high-water mark it is not ratcheted). `processExits` now handles the missing-price branch:
- if held ≥ `maxHoldMinutes` → close at `lastMarkUsd` (fallback to entry price if never marked),
  reason `timeout`, freeing the slot and booking honest PnL against the last mark;
- otherwise → leave open and retry next pass (unchanged).

Price-based exits (stop-loss / take-profit / trailing-stop) **still require a fresh price** — they
are never evaluated against a stale mark. Only the time-based timeout uses the last mark.

Touched: `domain.ts` (`lastMarkUsd?`), `paperBroker.ts` (`recordMark` sets last-mark + ratchets HWM;
`openPosition` seeds last-mark = entry), `sqliteStore.ts` (`last_mark_usd` column + migration +
load/save with entry fallback), `exitPositions.ts` (missing-price timeout branch, `minutesHeld`
helper). New tests cover the timeout-at-last-mark path, the entry-price fallback, the
within-window no-op, and last-mark persistence/round-trip. Suite: 65 → 67.

### Prior session (kept for context)

- Reviewed Codex's `6bcf1b9` hardening — verdict: correct, no reverts (shutdown wait, cash from
  persisted entry value, deterministic breaker bucket, `INSERT OR IGNORE` + dedup).
- Added the legacy-duplicate `closed_trades` dedup regression test (`43d254c`).

---

## Known remaining items (not addressed)

1. **Capacity-blocked candidates are marked `processed`, not retried** when capacity later frees.
2. **Migrate-time dedup runs on every startup** — unconditional full scan of `closed_trades`.
   Negligible for a paper bot; left as-is. Could be gated on index absence if it ever matters.
3. **Package name** still `hermes-agent` in `package.json`.
4. **No live trading** — paper-only by design.
5. Reporting: no per-source / score-bucket performance breakdown yet.

---

## Suggested Codex review focus

- The unpriceable-timeout policy: closing at `lastMarkUsd` (vs. entry, or refusing to close) — is
  booking PnL against a possibly-stale last mark the right call, or should a stale-timeout be
  flagged/booked differently (e.g. at entry to avoid fabricated PnL)?
- Confirm price-based exits remaining gated on a fresh price is the intended safety boundary.
