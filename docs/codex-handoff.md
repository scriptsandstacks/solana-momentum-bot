# Codex Handoff — Review of Claude Session 4

**Last updated:** 2026-06-01 · **Branch:** `development`
**Counterpart:** `docs/claude-handoff.md`

This is the current Codex-side handoff for reviewing the latest Claude follow-up work on the
Solana-first paper trading bot. The older PR #7 path-order notes have been superseded by Claude
Session 4 and are summarized here only where still relevant.

---

## Current branch state

Recent work on `development`:

1. **PR #7 — path-dependent outcome thresholds**
   - Added first TP/SL crossing timestamps.
   - Added path-aware outcome reporting.
2. **Claude Session 4 / PR #8 — rug screening + capacity retry**
   - Split legacy timestamp-less both-hit rows into `unknown` instead of `ambiguous`.
   - Added Jupiter sell-route probing to catch likely honeypot/no-sell candidates.
   - Persisted and reported `sell_route_available` on scored candidates.
   - Added retry of capacity-blocked candidates after exit passes.

Health reported and re-verified on this branch:

```text
npm test          -> 20 files, 104 tests passing
npm run typecheck -> clean
```

---

## What changed since the previous Codex handoff

### Outcome analytics semantics were refined

The old Codex concern was that legacy rows with both TP and SL reached but no crossing timestamps
were labeled `ambiguous`. Claude Session 4 changed this:

- same-timestamp TP/SL crossings remain `ambiguous`
- timestamp-less legacy both-hit rows are now `unknown`
- report lines now separate `ambig=` from `unkn=`

This resolves the prior `ambiguous` semantics concern.

### Sell-route / honeypot screening was added

Candidate routing now checks sellability in addition to buy route availability:

- Jupiter buy route still gates executable entry.
- Jupiter sell route probes token -> USDC with `ExactOut` for a small notional.
- `sellRouteAvailable` is carried on route/candidate/scored-candidate data.
- Scoring applies a heavy penalty and `no_sell_route` risk tag when sell route is explicitly false.
- SQLite stores `scored_candidates.sell_route_available` as nullable integer:
  - `NULL` = not checked / historical row
  - `0` = sell route unavailable
  - `1` = sell route available
- Reports annotate scored candidates with `sell=ok` / `sell=NO` when known.

This partially resolves the prior sellability/rug-screening gap. It does **not** replace on-chain
mint/freeze authority checks.

### Capacity-blocked candidate retry was added

The bot can now retry high-scoring candidates that were previously skipped only because max open
paper position capacity was full:

- `SqliteStore.listRetriableScoredCandidates()` selects the best recent scored row per mint.
- The query excludes candidates with an open position or a recent closed trade.
- `retryBlockedOpens()` opens eligible candidates using the stored scored price.
- `runBotLoop()` invokes retry after each exit pass and reports `retriedPositions`.

This resolves the prior known issue that capacity-blocked candidates were permanently lost.

---

## Current known remaining items

1. **On-chain Solana mint/freeze authority checks**
   - Sell-route screening catches many no-sell/honeypot cases.
   - Mint authority can still dilute holders.
   - Freeze authority can still lock accounts.
   - Add Solana RPC account checks and persist/report risk flags.

2. **Retry entry uses scored price, not a re-fetched price**
   - Acceptable for paper while inside `maxHoldMinutes`.
   - Before live trading, retry should re-quote/re-price and re-check sellability.

3. **Retry cooldown semantics need product review**
   - Current recent-closed guard uses the trade horizon (`maxHoldMinutes`).
   - Confirm whether that is the right cooldown or whether a shorter/larger dedicated retry cooldown
     should exist.

4. **Retry query runs every loop pass after exits**
   - Broker capacity checks make this a no-op when full.
   - SQLite overhead appears small, but watch during long runs.

5. **Migrate-time `closed_trades` dedup runs on every startup**
   - Currently negligible for paper trading.

6. **Package name remains `hermes-agent`**
   - Cosmetic cleanup.

7. **Paper-only / no live trading**
   - This remains intentional.
   - Do not introduce wallet/private-key use into paper commands.

8. **Exit timing is interval-based**
   - Positions can cross stops/targets between loop passes.
   - Accepted for paper; live trading needs real-time or much tighter monitoring.

9. **Outcome-tracking selection bias**
   - Unpriceable candidates are not sampled, so outcome analytics skew toward names that stayed
     liquid enough to price.

---

## Suggested Codex review focus

Review the Claude Session 4 implementation around these questions:

1. **Retriable candidate query correctness**
   - Does `ROW_NUMBER() OVER (PARTITION BY address ORDER BY score DESC, id DESC)` pick the right row?
   - Should recency outrank score, or is best-score-with-id-tiebreaker correct?
   - Are open-position and recent-closed exclusions robust?

2. **Retry cooldown policy**
   - Current cutoff tracks the trade horizon.
   - Decide whether retry suppression should be its own config field.

3. **Retry price realism**
   - Retried opens use the scored candidate price instead of re-fetching.
   - OK for paper? Should reports mark retried entries as `scored_price` sourced?

4. **Sell-route check behavior**
   - Confirm the $5 USDC `ExactOut` probe is the right notional and direction.
   - Confirm no-sell route should be a heavy penalty instead of a hard rejection.
   - Confirm undefined/historical sell-route status should remain neutral.

5. **Exit slippage fallback**
   - When no fresh sell quote exists during exit, the code may degrade to the entry route estimate.
   - Confirm this is better than refusing to apply slippage or closing with stale assumptions.

6. **Cost model accounting**
   - Entry costs are folded into effective entry fill price/quantity.
   - Confirm whether this is sufficient for paper analytics or whether a separate fee ledger is needed.

7. **Retention/prune preservation rule**
   - Rows for ever-traded mints may be over-preserved.
   - Confirm this is acceptable versus correlating scored rows to specific positions.

---

## Recommended immediate implementation order

1. Complete this Codex review pass and fix any blocking findings.
2. Add on-chain Solana mint/freeze authority checks with tests.
3. Run a longer paper session and inspect real `report`/outcome data.
4. Tune scoring/exits from paper outcomes.
5. Only then start disabled-by-default Base paper support.
