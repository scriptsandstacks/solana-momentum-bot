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
- This session (Claude): reviewed Codex's hardening and added one regression test.

**Health:** `npm test` → 65 passing · `npm run typecheck` → clean · `npm run bot -- manage-exits` smoke OK.

---

## Architecture recap (what exists today)

- **`src/bot/exitPositions.ts`** — `decideExit()` (pure) applies exit priority
  **take-profit > stop-loss > trailing-stop > timeout**. `processExits()` rehydrates the broker,
  re-prices open positions (DexScreener + Raydium), closes triggered ones, persists raised
  high-water marks for the rest. Unpriceable positions are left open and retried.
- **`src/paper/paperBroker.ts`** — `PaperBroker.restore()` rebuilds cash, open positions, the
  UTC-day daily-loss bucket, and the `paper-N` id sequence. Cash is **derived**, not persisted:
  `startingBalance + realizedPnl − sum(open.entryPriceUsd × quantity)`.
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

### Review of Codex's `6bcf1b9` — verdict: correct, no reverts

All five hardening fixes verified sound. Notably:
- **Shutdown wait** (`activeProcess` + `await` in `finally`): correct — `clearInterval` precedes the
  await, and `processInFlight` is set synchronously inside `processOnce`, so the overlap guard holds.
- **Cash from persisted entry value**: strictly better than the old `positionSizeUsd × count` —
  stays correct if config size changes while old positions remain open.
- **Deterministic breaker bucket** (`dailyRealizedPnlAt`): removes midnight-straddle nondeterminism.
- **`INSERT OR IGNORE` + unique index + migrate dedup**: sound idempotency boundary; a position
  closes once (ids never reused via `getNextPositionSeq`), so ignoring a duplicate is right.

### Added: regression test for legacy-duplicate dedup

`tests/sqliteStore.test.ts` → *"dedupes legacy duplicate closed_trades on migrate and builds the
unique index"*. Codex's migrate-time dedup had no permanent test (I had only verified it manually).
The test seeds a pre-index DB with duplicate `position_id` rows, opens it through `SqliteStore`
(running `migrate()`), and asserts: no throw, one row kept (lowest id / pnl 12.5), and a subsequent
duplicate `saveClosedTrade` is ignored. Suite: 64 → 65.

---

## Known remaining items (not addressed)

1. **Unpriceable positions never time out** — `maxHoldMinutes` requires a fresh price, so a
   permanently unpriceable mint stays open and holds its slot. Candidate fix: fall back to a
   last-known mark so timeouts can still fire. (Also in `docs/system.md`.)
2. **Capacity-blocked candidates are marked `processed`, not retried** when capacity later frees.
3. **Migrate-time dedup runs on every startup** — unconditional full scan of `closed_trades`.
   Negligible for a paper bot; left as-is. Could be gated on index absence if it ever matters.
4. **Package name** still `hermes-agent` in `package.json`.
5. **No live trading** — paper-only by design.
6. Reporting: no per-source / score-bucket performance breakdown yet.

---

## Suggested Codex review focus

- The new dedup regression test — is the "keep lowest id" expectation the policy you intended?
- Whether item #1 (unpriceable-position timeout) is worth doing next, and the right fallback-mark source.
