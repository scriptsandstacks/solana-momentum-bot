# Solana Trade Engine Engineering Handoff

**Author:** Codex / Claude Sonnet 4.6  
**Last updated:** 2026-06-06  
**Branch:** `feature/execution-quality-analytics`

## Current Health

```text
npm test          -> 40 files, 325 tests passing
npm run typecheck -> clean
git diff --check  -> clean
npm run bot -- --help -> clean; all commands listed
```

Solana Trade Engine is intentionally Solana-only. Paper and live trading share the same
strategy and execution-broker interface, and the owner can switch modes through
configuration without completing any mandatory paper-trading cycle.

## Current State — Ready for Paper and Live Trading

The bot is feature-complete for both paper and live trading. All operator steps
remaining before first live session are documented in `docs/go-live-runbook.md`.

### Operator setup checklist (not a code gap)

1. Set `walletFile` in `config.yaml` to the absolute path of the existing
   keypair on the deployment machine. The file does not need to be inside the
   project directory.
2. Export environment variables before running:
   ```bash
   export SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<key>
   export PUMPPORTAL_API_KEY=<key>
   export DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>  # optional
   ```
3. Run `npm run bot -- live-readiness` and resolve any blockers.
4. Run `npm run bot -- wallet-balances` to confirm SOL fee reserve and stablecoin inventory.
5. Set `mode: live` in `config.yaml` when ready.

## Live Execution State

All live trading plumbing is implemented and tested:

- Jupiter quote and swap transaction construction
- Solana keypair signing and RPC submission
- Block-height-aware confirmation using Jupiter `lastValidBlockHeight`
- Confirmed transaction balance-delta parsing for actual fill accounting
- Actual entry quantity, entry basis, exit proceeds, and realized P&L
- Raw Solana entry/exit fee persistence in lamports and USD
- Entry and exit transaction signatures persisted and shown in reports
- Real-time token activity exit triggers plus a 10-second exit backstop
- Startup wallet/SQLite reconciliation
- Persistent live execution journal (prepared → submitted → confirmed → persisted → failed)
- Live startup blocks when submitted or confirmed executions remain unpersisted
- `journal` lists blocking executions; `journal-resolve` only clears RPC-proven failed or expired submissions
- Interactive `recover-positions` for stale and orphaned positions
- Startup quarantine for stale positions
- SOL, USDC, and USDT live cash inventory with mint-specific funding checks
- Actual-size live route selection across funded wallet inputs
- Actual-size live price-impact cap before signing swaps
- Configurable live swap confirmation commitment (`confirmed` or `finalized`)
- SOL fee reserve enforcement — low-reserve wallets reject new entries but exits remain available

## Recent Work (this session)

### Execution quality analytics (`src/bot/analytics.ts`, `src/storage/sqliteStore.ts`)

`ClosedTradeStatRow` extended with `entryPriceUsd`, `exitPriceUsd`, `quantity`,
`entryNetworkFeeUsd`, `exitNetworkFeeUsd`. `TradeAnalytics` now includes an
`ExecutionQualityStats` section that separates price-movement P&L (strategy quality)
from network fee drag (execution cost). Shown in the `stats` command output for
live trades; paper trades are excluded since their cost model bakes fees into fill prices.

### `snapshot` CLI command (`src/bot/snapshot.ts`, `src/cli/index.ts`)

`npm run bot -- snapshot` prints a one-shot read-only operator view: live readiness
status, wallet balances (skipped gracefully in paper mode or when RPC is absent),
journal blocker count, open positions, recent trades, and analytics summary. Pure
rendering logic is in `src/bot/snapshot.ts` for testability. Not an interactive
dashboard — that is planned as a separate project.

### Discord notifications (`src/bot/discordReporter.ts`)

Implements the existing `Reporter` interface. Trade opens post green embeds; closes
post green/red based on P&L with fee and hold-time detail. Cycle summaries only fire
when at least one position opened or closed that cycle — no spam during quiet periods.
All webhook sends are fire-and-forget; a failed POST never blocks the run loop.
Configured via `discordWebhookUrlEnv` in the `notifications` config section.

### Data retention (`src/storage/sqliteStore.ts`, `src/bot/runLoop.ts`)

Two tables previously had no pruning:
- `token_volume_snapshots` — one row per scored candidate per cycle, no upper bound
- `pumpportal_events` — raw JSON blobs (1–5 KB each), could reach GB/year at peak

Added `pruneTokenVolumeSnapshots()` and `prunePumpPortalEvents()`, two new retention
config fields (`pumpPortalEventDays: 7`, `volumeSnapshotDays: 1`), updated `prune`
command to cover all three tables, and added auto-pruning to the run loop once per
UTC day. Pending PumpPortal events are never pruned automatically.

### Config fixes (`config.yaml`)

- Added `rpcUrlEnv: SOLANA_RPC_URL` — was in `config.example.yaml` but missing from
  the actual config, blocking live-readiness and disabling on-chain risk signals in
  paper mode.
- Added `priorityFeeLamports: auto` — dynamic Jupiter priority fee.
- Clarified `walletFile` comment — can be any absolute path on the machine.

## Important Files

| File | Purpose |
|---|---|
| `src/execution/liveBroker.ts` | Live broker state, entry, exit, cash, and P&L accounting |
| `src/execution/liveDeps.ts` | Production keypair, RPC, Jupiter, confirmation, and fill dependencies |
| `src/execution/liveReadiness.ts` | Static live prerequisite and policy audit logic |
| `src/execution/solanaTransactionFill.ts` | Confirmed wallet balance-delta parser |
| `src/execution/solanaTransactionHistory.ts` | Recent wallet buy lookup for orphan recovery |
| `src/execution/solanaConfirmation.ts` | Block-height-aware transaction confirmation |
| `src/execution/liveExecutionJournal.ts` | Journal types and incomplete-execution rendering |
| `src/execution/walletReconciler.ts` | Wallet holdings versus SQLite position reconciliation |
| `src/execution/positionRecovery.ts` | Pure stale/orphan recovery transformations |
| `src/storage/sqliteStore.ts` | Auto-migrating persistence layer with retention pruning |
| `src/bot/runLoop.ts` | Main process, exit, outcome, watcher, and auto-prune orchestration |
| `src/bot/analytics.ts` | Trade analytics including execution quality (fee drag) section |
| `src/bot/snapshot.ts` | Pure rendering for the operator snapshot command |
| `src/bot/discordReporter.ts` | Discord webhook reporter implementing the Reporter interface |
| `src/bot/reporter.ts` | Reporter interface — drop in Telegram or other reporters here |
| `docs/go-live-runbook.md` | Owner/operator live trading checklist and recovery sequence |

## Remaining Work

### Data calibration (not a code gap)

- Run in paper mode to accumulate trade data.
- Use `npm run bot -- tune` to validate volume acceleration, holder concentration,
  and authority penalties from observed MFE/MAE.
- Evaluate strategy thresholds independently after 50+ trades accumulate per strategy.

### Future: read-only UI (separate project)

A separate `crypto-bot-ui` repo is planned. Architecture decision recorded:
- Thin read-only API server reads the bot's SQLite file directly by path
- React/Next.js frontend
- Bot remains unaware the UI exists — no IPC needed
- One planned action: emergency stop (kill-switch flag the bot polls each cycle)
- API token auth required from day one — even before any actions are built
- No manual buy/open in the UI — all destructive ops stay CLI-only

The Discord reporter and CLI `snapshot` command cover operator monitoring needs
until the UI is built.

### Process management (not a code gap)

The bot has no systemd unit file or PM2 config. For server deployments, set up
a process manager so the bot restarts automatically after crashes or reboots.
A minimal `ecosystem.config.cjs` for PM2 is a ~10-minute task.

## Safe Continuation

```bash
npm test
npm run typecheck
git diff --check
```

Keep the paper-mode invariant intact when changing shared broker or run-loop
behavior. Never log or commit private keys, seed phrases, RPC keys, or API keys.

When adding new tables to SQLite, also add a corresponding prune method and
wire it into the `prune` CLI command and the run loop's auto-prune block.
