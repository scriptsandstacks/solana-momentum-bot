# Claude Handoff — Trading Realism + Analytics

**Last updated:** 2026-06-01 · **Branch:** `development` (post-session)
**Reviewer:** Codex (review this doc after Claude sessions). Counterpart: `docs/codex-handoff.md`.

This is a living handoff, rewritten at the end of each Claude session to reflect the **current**
state. The bot is paper-only, Solana-first.

---

## Current state

Four review-driven sprints plus one Claude follow-up session have landed since the paper-exit
lifecycle work:

1. **Trading blockers + paper-fill realism** — merged via **PR #5** (`feature-claude-review`).
2. **Analytics, outcome capture, retention** — merged via **PR #6** (`feature-scrutinize`).
3. **Path-dependent outcome thresholds** — merged via **PR #7** (`feature/outcome-path-order`).
4. **Rug screening + capacity retry** — Claude follow-up session, committed directly to `development`.

**Health:** `npm test` → 104 passing · `npm run typecheck` → clean · all CLI commands smoke OK.

---

## What landed since the last handoff

### Session 4 — rug screening + capacity retry (direct commits, `development`)

Six commits; all on `development`:

**Outcome analytics cleanup**
- `ambiguous` vs `unknown` split in path-order outcomes: legacy rows (no timestamps, both TP/SL
  hit) are now `unknown`; same-millisecond ties remain `ambiguous`. `OutcomeBucket` gains
  `unknownRatePct`; display shows `ambig=` and `unkn=` as separate columns. New test covers the
  same-millisecond tie case.

**Honeypot / sell-route screening**
- `checkJupiterRoute` now probes the sell direction (token→USDC ExactOut, $5) after the buy-route
  check. `JupiterRouteCheck` and `TokenCandidate` gain `sellRouteAvailable: boolean` (optional on
  raw DexScreener/Raydium candidates). Scoring applies a −50 penalty and `no_sell_route` risk tag
  when the sell probe explicitly fails; `undefined` (not checked) is neutral.
- `sell_route_available INTEGER` column added to `scored_candidates` (NULL = not checked, 0 = no
  sell route, 1 = ok). Migration adds the column to existing databases.
- `report` output annotates scored-candidate lines with `sell=ok` / `sell=NO`; old rows without the
  field are silently clean.

**Capacity-blocked retry**
- `listRetriableScoredCandidates` — new `SqliteStore` query using a CTE with `ROW_NUMBER` to
  return the best-scored, most-recent row per address for candidates that are within the trade
  horizon, above the score threshold, and have no open position or recent closed trade.
- `retryBlockedOpens` — opens positions for retriable candidates using the scored price as the
  paper entry (no re-fetch; only called within `maxHoldMinutes` so the price is a reasonable
  approximation). Stops as soon as the broker is at capacity.
- `runLoop` calls `retryBlockedOpens` after each exit pass (capacity is most likely to have freed
  there), accumulates `retriedPositions` in the result, and logs only when positions are actually
  opened to avoid per-tick noise.

---

## Known remaining items

Resolved since the prior handoff:
- ~~path-dependent outcome win/loss labeling~~ (PR #7)
- ~~ambiguous vs unknown outcome classification~~ (session 4)
- ~~No sellability/rug screening~~ (sell-route honeypot check, session 4 — partial; on-chain
  mint/freeze authority still missing)
- ~~Capacity-blocked candidates not retried~~ (session 4)

Still open:

1. **On-chain mint/freeze authority check** — sell-route screening catches honeypots; mint
   authority (creator can dilute) and freeze authority (creator can lock accounts) require a
   Solana RPC call not yet in the pipeline.
2. **Migrate-time `closed_trades` dedup runs on every startup** — negligible for a paper bot.
3. **Package name** still `hermes-agent` in `package.json` (cosmetic).
4. **No live trading** — paper-only by design.
5. **Exits only fire on the process interval** — a position can move past its stop/target between
   passes. Accepted for paper; needs real-time triggers before live.
6. **Outcome-tracking selection bias** — unpriceable candidates aren't sampled, so `outcomes`
   MFE/MAE skews toward names that stayed liquid.
7. **Retry uses scored price, not re-fetched price** — acceptable for paper within the horizon
   window; should be noted if ever ported to live.

---

## Suggested Codex review focus

- **Retry query correctness**: `listRetriableScoredCandidates` uses `ROW_NUMBER() OVER (PARTITION
  BY address ORDER BY score DESC, id DESC)` to deduplicate. The `NOT IN (SELECT address FROM
  closed_trades WHERE opened_at >= @cutoffIso)` guard prevents re-entering recently exited
  positions. Confirm the cutoff semantics are right — should "recently" be `maxHoldMinutes` (trade
  horizon) or something shorter?
- **Retry fires every tick, not just after closes**: `retryBlockedOpens` runs after every exit
  pass, not only when `exitResult.closed > 0`. The broker's `canOpenPosition()` check makes it a
  no-op at capacity, but it does hit SQLite on every pass. Acceptable overhead?
- **Silent thresholds skip confirmed acceptable**: both real callers (`run` loop and `track-outcomes`
  CLI) pass thresholds from the exits config, so crossing times are always stamped in production.
  Test-only callers without thresholds correctly produce `unknownRatePct` rather than silent zeros.
- **Prune preservation rule**: keeping *all* historical scored rows for any mint ever traded (vs
  time-correlating the scored row to the specific position). Over-preserves slightly — acceptable?
- **Exit slippage fallback**: when no Jupiter sell-quote is available the exit reuses the entry
  route estimate. Confirm that's the right degradation vs refusing to apply slippage.
- **Cost model accounting**: entry cost is folded into `entryPriceUsd` (fill price) with quantity
  reduced so the cash invariant holds — confirm that's the right place vs a separate fee ledger.
