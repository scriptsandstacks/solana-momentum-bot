# Solana Trade Engine — Solana Memecoin Trading Bot

Automated trading bot for Pump.fun tokens on Solana. Watches for newly created and migrating tokens in real time, filters them through scoring and multi-signal risk screens, and executes real on-chain swaps via Jupiter. Supports seamless switching between paper and live trading.

---

## Documentation

| Document | Audience |
|---|---|
| [docs/how-it-works.md](docs/how-it-works.md) | Non-technical — strategies, edge, risk management, reading reports |
| [docs/system.md](docs/system.md) | Technical — architecture, data flow, strategy logic, exit rules, CLI reference |
| [docs/handoff.md](docs/handoff.md) | Engineering — current implementation state, open items, next steps |

---

## Strategies

**Fresh Launch Momentum** — targets `new_token` events (tokens created on Pump.fun in the last 5–90 minutes). Entry score ≥ 75. Position sized by conviction: 90+ → 1.5×, 80-89 → 1.0×, 75-79 → 0.75×.

**Migration Momentum** — targets `migration` events (tokens that completed the Pump.fun bonding curve and listed on Raydium). Entry score ≥ 70. Tighter exits (25-minute hold, arms at +15%, trails at 12%).

Both strategies run simultaneously with automatic event routing.

---

## Exit model

Two-phase trailing stop — cuts losers fast while letting winners run:

- **Phase 1** (below arm threshold): only the hard stop-loss fires
- **Phase 2** (once position is up past the arm threshold): trailing stop activates from the peak

Fresh launch: stop-loss 20%, arm at +30%, trail 15%, hold max 60 min.
Migration: stop-loss 18%, arm at +15%, trail 12%, hold max 25 min.

---

## Risk signals

Every candidate is screened for: Jupiter sell route (honeypot detection), Solana mint/freeze authority (rug risk), top-5 holder concentration, and volume acceleration z-score. All signals are persisted and included in outcome analytics.

---

## Quickstart

```bash
npm install
npm test
npm run bot -- --help
```

**Paper trading** (no wallet required):
```bash
export SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<key>
export PUMPPORTAL_API_KEY=<key>
npm run bot -- run
```

`SOLANA_RPC_URL` enables on-chain risk signals (mint authority, holder concentration) in paper mode. The bot will run without it but scoring will be degraded.

**Before going live:**

Read the operator checklist in [`docs/go-live-runbook.md`](docs/go-live-runbook.md).

```bash
# Audit all prerequisites (no keys read, no trades placed)
npm run bot -- live-readiness

# Full operator snapshot: readiness, balances, positions, journal, analytics
npm run bot -- snapshot

# Verify route-input inventory and SOL fee reserve (no trades placed)
npm run bot -- wallet-balances

# Check wallet/SQLite are in sync (dry run)
npm run bot -- recover-positions --dry-run

# Then set mode: live in config.yaml and run
SOLANA_RPC_URL=https://... PUMPPORTAL_API_KEY=... npm run bot -- run
```

**Discord notifications** (optional — posts trade opens/closes to a channel):
```bash
# Create a webhook in Discord: channel settings → Integrations → Webhooks
export DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
```
Set `discordWebhookUrlEnv: DISCORD_WEBHOOK_URL` in `config.yaml` under `notifications`.

**`walletFile` in `config.yaml`** can be any path on the machine — absolute or relative. It does not need to be inside the project directory and is only read in live mode.

---

## Commands

| Command | What it does |
|---|---|
| `run` | Main loop: watch PumpPortal, process events, manage exits, track outcomes, auto-prune daily. Exits run on a separate interval by default so paper/live positions are checked even when candidate processing is busy. Live mode: real Jupiter swaps with real-time WebSocket exit triggers. |
| `snapshot` | One-shot read-only operator view: readiness, wallet balances, open positions, recent trades, journal status, analytics summary |
| `live-readiness` | Audit every live-trading prerequisite without reading keys or placing trades |
| `wallet-balances` | Read live wallet SOL/USDC/USDT balances and SOL fee reserve status without placing trades |
| `journal` | List submitted or confirmed live executions that still need reconciliation |
| `journal-resolve` | Mark an RPC-proven failed or expired live execution as resolved |
| `recover-positions` | Resolve wallet/SQLite discrepancies after crashes (`--dry-run`, `--yes`) |
| `report` | Persisted scores, open positions, closed trades, events |
| `stats` | Trade analytics: expectancy, win rate, P&L by strategy / reason / score bucket. Includes execution quality section (fee drag vs price-movement P&L) for live trades. |
| `strategies` | Compact per-strategy performance table |
| `outcomes` | Counterfactual MFE/MAE for all scored candidates by score bucket |
| `tune` | Outcome data → specific threshold recommendations. `--apply` writes to config. |
| `pump-watch` | Bounded PumpPortal listener |
| `pump-process` | Process pending events into scored candidates |
| `manage-exits` | One-shot exit pass |
| `track-outcomes` | One-shot forward price capture |
| `prune` | Delete old scored candidates, processed PumpPortal events, and volume snapshots to reclaim disk |
| `check-route` | Read-only Jupiter route smoke test for a token mint |

---

## Improvement cycle

```
Use paper mode to calibrate, or switch to live when the owner is ready
        ↓
stats + strategies → is expectancy positive?
outcomes → is the threshold set correctly?
tune → what specifically needs to change?
        ↓
Adjust config.yaml
        ↓
Repeat until consistently profitable
        ↓
live-readiness → confirm all prerequisites met
Switch mode: live
```

---

## Data retention

The bot accumulates data in a local SQLite database (`data/solana-trade-engine.sqlite`). The run loop auto-prunes once per UTC day using the windows in `config.yaml`:

| Table | Default retention | Notes |
|---|---|---|
| `scored_candidates` | 30 days | Candidates that never led to a position. Also the counterfactual window for `outcomes`. |
| `pumpportal_events` | 7 days | Raw event blobs (~1–5 KB each). Only processed events are pruned. |
| `token_volume_snapshots` | 1 day | Used only for the 30-minute volume acceleration z-score. |
| `closed_trades` | Forever | Your permanent trade record. Never pruned. |

Run `npm run bot -- prune --dry-run` to preview what would be cleaned up, or `npm run bot -- prune` to trigger it manually.

---

## Safety

- `wallet/`, `.env`, `data/`, `logs/`, `node_modules/` are git-ignored
- Never commit or log private keys, seed phrases, or API keys
- In paper mode no real swaps are submitted and no wallet files are read
- In live mode the wallet keypair is loaded at runtime from `walletFile` (never embedded in config)
- Discord webhook sends are fire-and-forget — a failed POST never blocks the run loop
