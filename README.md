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
PUMPPORTAL_API_KEY=your_key npm run bot -- run
```

**Before going live:**
```bash
# Audit all prerequisites (no keys read, no trades placed)
npm run bot -- live-readiness

# Verify route-input inventory and SOL fee reserve (no trades placed)
npm run bot -- wallet-balances

# Check wallet/SQLite are in sync (dry run)
npm run bot -- recover-positions --dry-run

# Then set mode: live in config.yaml and run with your key + RPC URL
SOLANA_RPC_URL=https://... PUMPPORTAL_API_KEY=... npm run bot -- run
```

---

## Commands

| Command | What it does |
|---|---|
| `run` | Main loop: watch PumpPortal, process events, manage exits, track outcomes. Live mode: real Jupiter swaps with real-time WebSocket exit triggers. |
| `live-readiness` | Audit every live-trading prerequisite without reading keys or placing trades |
| `wallet-balances` | Read live wallet SOL/USDC/USDT balances and SOL fee reserve status without placing trades |
| `recover-positions` | Resolve wallet/SQLite discrepancies after crashes (`--dry-run`, `--yes`) |
| `report` | Persisted scores, open positions, closed trades, events |
| `stats` | Trade analytics: expectancy, win rate, P&L by strategy / reason / score bucket |
| `strategies` | Compact per-strategy performance table |
| `outcomes` | Counterfactual MFE/MAE for all scored candidates by score bucket |
| `tune` | Outcome data → specific threshold recommendations. `--apply` writes to config. |
| `pump-watch` | Bounded PumpPortal listener |
| `pump-process` | Process pending events into scored candidates |
| `manage-exits` | One-shot exit pass |
| `track-outcomes` | One-shot forward price capture |
| `prune` | Delete old untraded scored candidates |
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

## Safety

- `wallet/`, `.env`, `data/`, `logs/`, `node_modules/` are git-ignored
- Never commit or log private keys, seed phrases, or API keys
- In paper mode no real swaps are submitted and no wallet files are read
- In live mode the wallet keypair is loaded at runtime from `walletFile` (never embedded in config)
