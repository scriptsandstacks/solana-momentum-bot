# Claude Handoff — Trading Realism + Analytics

**Last updated:** 2026-06-01 · **Branch:** `development` (post-PR #7)
**Reviewer:** Codex (review this doc after Claude sessions). Counterpart: `docs/codex-handoff.md`.

This is a living handoff, rewritten at the end of each Claude session to reflect the **current**
state. The bot is paper-only, Solana-first.

---

## Current state

Three review-driven sprints have landed since the paper-exit lifecycle work:

1. **Trading blockers + paper-fill realism** — merged via **PR #5** (`feature-claude-review`).
2. **Analytics, outcome capture, retention** — merged via **PR #6** (`feature-scrutinize`).
3. **Path-dependent outcome thresholds** — merged via **PR #7** (`feature/outcome-path-order`).

**Health:** `npm test` → 93 passing · `npm run typecheck` → clean · all CLI commands smoke OK.

---

## What landed since the last handoff

### Sprint 3 — path-dependent outcomes (PR #7)

Resolved the open review item from PR #6: `outcomes` MFE/MAE captured *whether* TP/SL were hit,
but not *which crossed first*, so "reached TP" and "hit SL" could both be true for the same row,
making the rates misleading for win/loss labeling and threshold tuning.

- **New `scored_candidates` columns**: `outcome_first_tp_at TEXT` and `outcome_first_sl_at TEXT`
  record the first time price crossed each threshold. Stamped once; never overwritten on later passes.
- **`trackCandidateOutcomes`** now accepts optional `thresholds: { takeProfitPct, stopLossPct }`.
  Both the `run` loop and the `track-outcomes` CLI command pass the exits config thresholds in.
- **`firstCrossing()`** in `analytics.ts`: if both timestamps exist and differ, whichever is earlier
  wins; if equal (same-millisecond), outcome is `ambiguous`; if no timestamps but both flags set,
  also `ambiguous`; if only one flag is set, that side wins; if neither, `none`.
- **`OutcomeBucket`** gains `tpFirstRatePct`, `slFirstRatePct`, `ambiguousRatePct`; the `outcomes`
  display now shows all three alongside the existing `hitTP`/`hitSL` columns.

---

## Known remaining items

Resolved since the prior handoff: ~~path-dependent outcome win/loss labeling~~ (now PR #7).

Still open:

1. **Capacity-blocked candidates are marked `processed`, not retried** when capacity later frees.
2. **Migrate-time `closed_trades` dedup runs on every startup** — negligible for a paper bot.
3. **Package name** still `hermes-agent` in `package.json` (cosmetic).
4. **No live trading** — paper-only by design.
5. **Exits only fire on the process interval** — a position can move past its stop/target between
   passes. Accepted for paper; needs real-time triggers before live.
6. **Outcome-tracking selection bias** — unpriceable candidates aren't sampled, so `outcomes`
   MFE/MAE skews toward names that stayed liquid (high "no price" rate is itself a rug signal).
7. **No sellability/rug screening** — the biggest paper-vs-live realism gap for pump.fun.

---

## Suggested Codex review focus

- **`ambiguous` vs `unknown` in path-order outcomes**: legacy rows without timestamps but with both
  TP and SL flags are currently bucketed as `ambiguous`. A separate `unknown` category would
  distinguish "we genuinely don't know order" (no timestamps, pre-PR #7 data) from "both thresholds
  were crossed within the same millisecond" (extremely rare but technically distinct). Worth the
  added complexity, or is `ambiguous` sufficient for both cases?
- **Silent skip when thresholds absent**: if `trackCandidateOutcomes` is called without `thresholds`
  (possible from tests or future callers), crossing times are simply never stamped. The null guard
  is silent. Should it warn, or is the silent fallback acceptable?
- **Prune preservation rule**: keeping *all* historical scored rows for any mint ever traded (vs
  time-correlating the scored row to the specific position). Over-preserves slightly — acceptable?
- **Exit slippage fallback**: when no Jupiter sell-quote is available the exit reuses the entry
  route estimate. Confirm that's the right degradation vs refusing to apply slippage.
- **Cost model accounting**: entry cost is folded into `entryPriceUsd` (fill price) with quantity
  reduced so the cash invariant holds — confirm that's the right place vs a separate fee ledger.
