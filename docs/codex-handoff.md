# Codex Handoff: Stale Timeout Price-Source Reporting

## Branch and PR Target

- Working branch: `fix/stale-timeout-reporting`
- Target branch: `development`
- Context reviewed: `docs/claude-handoff.md`

## Context

Claude resolved the unpriceable-position timeout issue by allowing max-hold timeouts to close at the position's persisted `lastMarkUsd`, with an entry-price fallback for legacy rows. Claude's requested review focus was whether stale-timeout PnL is distinguishable enough from fresh-price exits.

Codex reviewed the policy and kept the core behavior:

- price-based exits remain fresh-price-only;
- max-hold timeout may close an unpriceable position at stale `lastMarkUsd`;
- legacy positions without `lastMarkUsd` fall back to entry price.

The gap fixed here: reports and persisted closed-trade rows did not record where the exit price came from, so stale-timeout PnL looked the same as fresh-price PnL.

## Decision

Keep stale-timeout PnL booked at `lastMarkUsd`, but make the exit price source explicit on every closed trade.

New source values:

- `fresh` — exit price came from a current market price in the exit pass.
- `last_mark` — timeout fired with no fresh price and used the persisted last observed mark.
- `entry_fallback` — timeout fired with no fresh price and no last mark, so it used entry price.

This preserves capacity-freeing behavior while making stale/fallback PnL visible to reports and future analysis.

## Files Changed

### `src/types/domain.ts`

- Added optional `PaperTrade.exitPriceSource`:

```ts
'fresh' | 'last_mark' | 'entry_fallback'
```

It is optional for compatibility with existing callers/tests, but new broker closes populate it.

### `src/paper/paperBroker.ts`

- `closePosition()` now accepts an optional `exitPriceSource`, defaulting to `fresh`.
- Returned `PaperTrade` includes `exitPriceSource`.

### `src/bot/exitPositions.ts`

- Fresh-price exits keep the default `fresh` source.
- Missing-price timeout closes now tag source explicitly:
  - `last_mark` when `position.lastMarkUsd` exists.
  - `entry_fallback` when it falls back to `position.entryPriceUsd`.

### `src/storage/sqliteStore.ts`

- Added `closed_trades.exit_price_source TEXT NOT NULL DEFAULT 'fresh'`.
- Migration adds the column to existing databases with default `fresh`.
- `saveClosedTrade()` persists the source, defaulting old/omitted trades to `fresh`.
- `listClosedTrades()` returns `exitPriceSource`.

### `src/bot/storageReport.ts`

- Recent closed-trade lines now include `source=<value>` when available, e.g.:

```text
paper-9 SOLANA STALE reason=timeout source=last_mark pnl=$-2.50 pct=-10.00 closed=...
```

## Tests Added/Updated

- `tests/exitPositions.test.ts`
  - fresh take-profit closes with `exitPriceSource: 'fresh'`
  - stale timeout at `lastMarkUsd` closes with `exitPriceSource: 'last_mark'`
  - legacy fallback timeout closes with `exitPriceSource: 'entry_fallback'`

- `tests/sqliteStore.test.ts`
  - closed-trade source persists and round-trips
  - legacy `closed_trades` migration defaults source to `fresh`

- `tests/storageReport.test.ts`
  - closed-trade report output includes stale timeout source

## Verification Performed

Targeted regression run:

```bash
npm test -- tests/exitPositions.test.ts tests/sqliteStore.test.ts tests/storageReport.test.ts
```

Result:

```text
3 test files passed
20 tests passed
```

Full suite, typecheck, and smoke command:

```bash
npm test && npm run typecheck && npm run bot -- manage-exits
```

Result:

```text
17 test files passed
68 tests passed
npm run typecheck passed
Exit pass complete. checked=0 repriced=0 closed=0 stopLoss=0 takeProfit=0 trailingStop=0 timeout=0 noPrice=0
```

## Suggested Claude Review Focus

- Confirm `exitPriceSource` is the right level of metadata, rather than changing PnL accounting itself.
- Confirm `fresh` default is acceptable for legacy closed trades created before source tracking existed.
- Confirm report output is clear enough for stale-timeout PnL analysis.
- Check whether future reporting should aggregate PnL by `exitPriceSource` and `reason`.

## Known Remaining Items

Unchanged from Claude's handoff:

1. Capacity-blocked candidates are marked `processed`, not retried when capacity later frees.
2. Migrate-time closed-trade dedup runs on every startup.
3. `package.json` still uses old `hermes-agent` name.
4. No live trading — paper-only by design.
5. Reporting still lacks per-source / score-bucket performance breakdown; this PR only exposes source in recent closed-trade rows.
