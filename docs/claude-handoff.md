# Claude Handoff — Strategy, Execution & Reporting Architecture

**Last updated:** 2026-06-02 · **Branch:** `feature/strategy-interface-and-analytics`
**Reviewer:** Codex. Counterpart: `docs/codex-handoff.md`.

Paper-only. Do not introduce live wallet/private-key use.

---

## Current state

All 7 commits on `feature/strategy-interface-and-analytics` on top of `development` (PR #9).

**Health:**

```text
npm test          -> 21 files, 113 tests passing
npm run typecheck -> clean
```

---

## What this branch built

### Strategy interface (complete)

`TradingStrategy` typed interface: `id`, `config`, `tagCandidate`, `scoreCandidate`.

- `createFreshLaunchStrategy(config?)` factory — CLI creates it from file config.
- `freshLaunchMomentumStrategy` convenience singleton for tests.
- `StrategyConfig` carries `minScoreToEnter` + optional per-strategy `exits` overrides.
- `pumpProcess` calls `strategy.scoreCandidate()` — strategy owns scoring logic.
- `pumpProcess` calls `strategy.tagCandidate()` — all scored candidates carry `strategyId`.

### Execution broker interface (complete)

`src/execution/broker.ts` — `ExecutionBroker` typed contract.

`PaperBroker implements ExecutionBroker` with `mode = 'paper'`.

To add live trading:
1. Implement `LiveBroker implements ExecutionBroker` in `src/execution/liveBroker.ts`.
2. `LiveBroker.openPosition()` → submit Jupiter swap transaction + sign with wallet.
3. `LiveBroker.closePosition()` → submit sell transaction.
4. CLI `run`: branch on `config.mode === 'live'`, build `LiveBroker`.
   The pipeline (`pumpProcess`, `exitPositions`, `runLoop`) is unchanged.

Config schema has `mode: 'paper' | 'live'`. CLI currently guards against `live` with a helpful error.

### Reporting (complete)

**During `run`:**
- `[trade] OPENED ...` / `[trade] CLOSED ...` lines from `Reporter` on every position event.
- `[cycle] ...` line after every pass: events processed, opened, closed, cash, open count.
- `[analytics] ...` every N passes (default 10, `--analytics-every` flag): full `stats` output.

**CLI commands:**

| Command | Output |
|---|---|
| `report` | Persisted scores, open positions (with strat=), closed trades (with strat=), pump events |
| `stats` | Full analytics: overall + by strategy, exit reason, score bucket, source |
| `strategies` | Compact per-strategy table: trades, win%, P&L, expectancy, profit factor, hold |
| `outcomes` | Candidate MFE/MAE counterfactual by score bucket |

### Strategy exit overrides (complete)

`resolveExits` in `processExits` + `runLoop`: each position is evaluated against its owning
strategy's exit thresholds (from `strategy.config.exits`) rather than the global ones.

`buildExitResolver(strategy, globalExits)` in CLI merges strategy overrides over globals.

### Solana mint/freeze authority screening (complete)

`src/chains/solana/mintAuthority.ts` — read-only RPC `getAccountInfo` on SPL mint account.

- `mintAuthorityRevoked: false` → -20 pts, `mint_authority_held` risk tag.
- `freezeAuthorityRevoked: false` → -15 pts, `freeze_authority_held` risk tag.
- Both revoked → small bonus, positive reason tags.
- Flags stored in `token_json` blob, visible in scored candidate reporting.

Runs automatically when `solanaConfig.rpcUrlEnv` resolves to a URL; skipped otherwise.
Inject `checkAuthority` fn in tests. `checkAuthority: null` disables explicitly.

---

## Remaining open items

### Strategy abstraction

- [ ] **Multiple strategies simultaneously** — `pumpProcess` still hard-codes
  `freshLaunchMomentumStrategy`. When a second strategy exists, a registry/router
  selects per candidate. Defer until a second strategy is defined.

### Risk screening

- [ ] **Persist authority flags as DB columns** — currently stored in `token_json` blob only.
  Adding `mint_authority_revoked` / `freeze_authority_revoked` columns to `scored_candidates`
  enables direct SQL queries (e.g. "show all held-authority tokens that still scored above 70").
- [ ] **Report authority flags in storage report** — show `mint=revoked|held|?` per scored row.

### Reporting

- [ ] **`report` / `stats` output formatting** — currently plain text lines. Could be a tabular
  ASCII table for easier reading, especially for the `strategies` command.

### Live trading (after paper is stable)

- [ ] **`LiveBroker` implementation** — Jupiter swap submission + wallet signing. Requires reading
  `walletFile` from chain config and loading the Solana keypair.
- [ ] **Real-time exit triggers** — exits fire on process interval only; live needs WebSocket
  price feeds or tighter polling.
- [ ] **Base paper support** — after Solana paper is confirmed stable.

### Minor

- [ ] **Package name** — still `hermes-agent` in `package.json`.
- [ ] **Retry uses scored price, not re-fetched price** — acceptable for paper.

---

## Safe continuation checklist

```bash
npm test
npm run typecheck
git diff --check
```
