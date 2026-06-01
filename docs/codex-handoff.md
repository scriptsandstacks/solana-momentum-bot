# Codex Handoff: Path-Dependent Outcome Thresholds

## Branch and PR Target

- Working branch: `feature/outcome-path-order`
- Target branch: `development`
- Merged: PR #7
- Context reviewed: `docs/claude-handoff.md`

## Context

Claude's outcome analytics (PR #6) captured only MFE/MAE/final over the trade horizon — sufficient to know *whether* TP and SL were each hit, but not *which crossed first*. Claude flagged this in the review focus: both flags can be true for a single candidate, which makes the `reachedTpRatePct`/`hitSlRatePct` numbers misleading for win/loss labeling and threshold tuning.

## Decision

Record the first crossing timestamp for each threshold, then use timestamp ordering to classify outcomes as `tp` (TP crossed before SL), `sl` (SL crossed before TP), or `ambiguous` (both timestamps identical or both absent but both flags set). Rows with no timestamps fall back gracefully: if only TP crossed, classify `tp`; if only SL, classify `sl`; if neither, classify `none`; if both but no timestamps, classify `ambiguous`.

This keeps the existing MFE/MAE columns intact (no regression) and adds the path-order dimension as new columns and new bucket fields.

## Files Changed

### `src/storage/sqliteStore.ts`

- New columns `outcome_first_tp_at TEXT` and `outcome_first_sl_at TEXT` on `scored_candidates`.
- Migration adds both columns to existing databases (`addColumnIfMissing`).
- `TrackableScoredCandidateRow`, `ScoredOutcomeUpdate`, and `ScoredOutcomeStatRow` interfaces extended.
- `getTrackableScoredCandidates()` and `getScoredOutcomeStats()` SELECTs include the new columns.
- `recordScoredOutcome()` UPDATE persists both new fields.

### `src/bot/trackOutcomes.ts`

- `TrackOutcomesOptions` now accepts optional `thresholds: { takeProfitPct, stopLossPct }`.
- `crossesTakeProfit()` / `crossesStopLoss()` helpers compute threshold crossings cleanly.
- First-crossing timestamps are stamped on the current pass only if not already set — once written, they are never overwritten.
- `outcomeFirstTakeProfitAt` and `outcomeFirstStopLossAt` are included in every `recordScoredOutcome` call.

### `src/bot/runLoop.ts`

- `TrackOutcomes` type updated to include optional `thresholds`.
- `runBotLoop` passes `takeProfitPct`/`stopLossPct` from the exits config to `trackOutcomes`.

### `src/cli/index.ts`

- `track-outcomes` command passes `thresholds` from config so one-off CLI passes also stamp crossing times.

### `src/bot/analytics.ts`

- `OutcomeRow` extended with `outcomeFirstTakeProfitAt` and `outcomeFirstStopLossAt`.
- `OutcomeBucket` extended with `tpFirstRatePct`, `slFirstRatePct`, `ambiguousRatePct`.
- New `firstCrossing()` pure function implements the timestamp-ordering logic.
- `summarizeOutcomes()` computes crossing classification per row and aggregates the three new rates.
- `outcomeBucketLine()` output extended to show `tpFirst=`, `slFirst=`, `ambiguous=` columns.

## Tests Added/Updated

### `tests/trackOutcomes.test.ts`

- Verifies that `outcomeFirstTakeProfitAt` is preserved from an earlier pass when a new SL crossing is stamped on a later pass (no overwrite).

### `tests/analytics.test.ts`

- Uses three rows (tp-first, sl-first, both-ambiguous) to verify each rate comes out at ~33.3%.
- Verifies rendered output contains `tpFirst=` / `slFirst=` / `ambiguous=` columns.

## Verification Performed

```bash
npm test && npm run typecheck
```

Result:

```text
19 test files passed
93 tests passed
npm run typecheck passed
```

## Suggested Claude Review Focus

- **`ambiguous` bucket semantics**: legacy rows without timestamps but with both TP and SL flags set are classified `ambiguous`. Is that the right label, or should they be a separate `unknown` bucket so truly ambiguous (same-millisecond crossing) is distinguishable from "we didn't have timestamp data"?
- **`thresholds` not required**: if neither `run` nor `track-outcomes` pass thresholds, crossing times are never stamped (the null guard in `trackOutcomes.ts` silently skips them). Confirm this silent fallback is acceptable vs. requiring thresholds or warning when they are absent.
- **`outcomes` display**: the three new columns make each bucket line noticeably wider. Consider whether a two-line layout or a compact flag column is better for terminal readability.
- **Aggregate by path order**: the per-bucket rates now exist; consider adding a threshold-sensitivity sweep (vary TP/SL, plot how `tpFirstRatePct` changes) as the next analytics step.

## Known Remaining Items

Unchanged from Claude's handoff (PR #6):

1. Capacity-blocked candidates are marked `processed`, not retried when capacity later frees.
2. Migrate-time closed-trade dedup runs on every startup.
3. `package.json` still uses `hermes-agent` name (cosmetic).
4. No live trading — paper-only by design.
5. Exit re-pricing fires only on the process interval; positions can move past stop/target between passes.
6. Outcome-tracking selection bias: unpriceable candidates are never sampled, so `outcomes` MFE/MAE skews toward names that stayed liquid.
7. No sellability / rug screening — biggest paper-vs-live realism gap for pump.fun.
