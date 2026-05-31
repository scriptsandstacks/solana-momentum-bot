# Claude Handoff — Trading Realism + Analytics

**Last updated:** 2026-05-31 · **Branch:** `feature-scrutinize` (PR #6 → `development`)
**Reviewer:** Codex (review this doc after Claude sessions). Counterpart: `docs/codex-handoff.md`.

This is a living handoff, rewritten at the end of each Claude session to reflect the **current**
state. The bot is paper-only, Solana-first.

---

## Current state

Two review-driven sprints landed since the paper-exit lifecycle work:

1. **Trading blockers + paper-fill realism** — merged to `development` via **PR #5** (`feature-claude-review`).
2. **Analytics, outcome capture, retention** — open in **PR #6** (`feature-scrutinize`), this session.

**Health:** `npm test` → 91 passing · `npm run typecheck` → clean · all CLI commands smoke OK
(`stats`, `outcomes`, `track-outcomes`, `prune --dry-run/--prune`, `check-route`, `manage-exits`).

The original end-to-end review lives in the conversation; the headline was that the bot **could not
open trades** (dead Jupiter endpoint) and paper PnL was **frictionless fantasy**. Both are fixed,
and the system can now be tuned from data.

---

## What landed since the last handoff

### Sprint 1 — realism (merged, PR #5)

- **Jupiter migration.** Quote API V6 (`quote-api.jup.ag/v6`) was deprecated 2025-10-01, so every
  route check failed → every candidate scored `no_route` → nothing traded. Now uses the Swap API
  with auto host selection: keyless `lite-api.jup.ag` by default, keyed `api.jup.ag` when
  `JUPITER_API_KEY` is set (`JUPITER_QUOTE_URL` overrides). Also fixed a mistyped USDT input mint.
- **Cost model on paper fills.** New `fees` config (`swapFeeBps`, `applyRouteSlippage`) worsens both
  legs: entry buys fewer tokens (`entryPriceUsd` records the real fill; marks still track mid), exit
  nets less. Cash invariant preserved. Omitting `fees` keeps the frictionless path.
- **Fresh exit sell-quote.** `quoteJupiterSellImpactBps` (Jupiter ExactOut, token → exact USD in
  USDC, so no token decimals needed) prices the exit leg at the real position size/direction;
  `closePosition` prefers it over the entry estimate. Best-effort with fallback.
- **Raydium fresh-mint fixes.** (a) Volume was a flat `day/288` split that understated fresh pools
  into failing the volume filter — now prorated by actual pool lifetime. (b) The mint merge
  overwrote DexScreener's real volume/buy-sell/momentum with Raydium's zeros when the Raydium pool
  was deeper — now merges field-wise (price/liquidity from the deepest pool, activity from a source
  that reports it).
- **`paper` command fix.** `runPaperCycle` used a fresh broker (could exceed the cap / double-count
  cash) and `break`-ed on the first blocked open (dropped later scored rows). Now rehydrates from
  SQLite like `pump-process`/`manage-exits` and continues past blocked opens.
- **`check-route <mint>`** read-only smoke command.

### Sprint 2 — analytics + retention (this session, PR #6)

- **`src/bot/analytics.ts`** — pure aggregation.
  - `computeTradeAnalytics` (realized trades): expectancy, win rate, avg win/loss, profit factor,
    avg hold, bucketed by exit reason / exit-price source / score bucket / discovery source. Needs
    the entry `score` + `source` now persisted on `closed_trades` (new columns).
  - `computeOutcomeAnalytics` (counterfactual): MFE/MAE, avg final return, and take-profit/stop-loss
    hit rates by score bucket and recommendation.
- **`src/bot/trackOutcomes.ts`** — `trackCandidateOutcomes` re-prices recently scored candidates over
  the trade horizon (`exits.maxHoldMinutes`), seeding excursion bounds from the scored price,
  ratcheting high/low, finalizing past the horizon. Runs automatically each interval inside `run`
  (guarded by `canTrackOutcomes`), and as the standalone `track-outcomes` command.
- **New `scored_candidates` columns**: `outcome_high_usd`, `outcome_low_usd`, `outcome_last_usd`,
  `outcome_samples`, `outcome_last_at`, `outcome_done` (+ migration + index).
- **`prune` command + `retention.scoredCandidateDays`** (default 30). Deletes scored candidates
  older than the window that never led to a position (mints in `open_positions`/`closed_trades` are
  preserved); runs `VACUUM`; `--dry-run`/`--days`/`--no-vacuum`. Explicit, not automatic.
- **New CLI**: `stats`, `outcomes`, `track-outcomes`, `prune`.

---

## Known remaining items

Resolved since the prior handoff: ~~reporting lacks per-source/score-bucket breakdown~~ (now `stats`
+ `outcomes`); ~~`paper` rehydration bug~~; the realism gaps (#3/#4/#5 from the review).

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

- **Outcome MFE/MAE methodology** (`trackOutcomes.ts` + `computeOutcomeAnalytics`): we capture only
  max/min/last over the horizon, not the path order, so "reached TP" and "hit SL" can both be true
  for one candidate. Is max/min sufficient for threshold tuning, or should we record which came
  first (path-dependent win/loss labeling)?
- **Prune preservation rule**: keeping *all* historical scored rows for any mint ever traded (vs
  time-correlating the scored row to the specific position). Over-preserves slightly — acceptable?
- **Exit slippage fallback**: when no Jupiter sell-quote is available the exit reuses the entry
  route estimate. Confirm that's the right degradation vs refusing to apply slippage.
- **Cost model accounting**: entry cost is folded into `entryPriceUsd` (fill price) with quantity
  reduced so the cash invariant holds — confirm that's the right place vs a separate fee ledger.
