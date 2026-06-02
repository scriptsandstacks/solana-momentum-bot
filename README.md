# Hermes — Solana Memecoin Paper Trading Bot

Automated paper trading bot for Pump.fun tokens on Solana. Watches for newly created and migrating tokens in real time, filters them through scoring and risk screens, and simulates trades with realistic fees and slippage. Paper-trading only until results are proven.

---

## Documentation

| Document | Audience |
|---|---|
| [docs/how-it-works.md](docs/how-it-works.md) | Non-technical — explains the strategies, edge, risk management, and how to read reports |
| [docs/system.md](docs/system.md) | Technical — architecture, data flow, strategy logic, exit rules, CLI reference |
| [docs/claude-handoff.md](docs/claude-handoff.md) | Engineering — current implementation state, open items, next steps |

---

## Strategies

**Fresh Launch Momentum** — targets `new_token` events (tokens created on Pump.fun in the last 5–90 minutes). Entry score ≥ 75. Position sized by conviction: 90+ → 1.5×, 80-89 → 1.0×, 75-79 → 0.75×.

**Migration Momentum** — targets `migration` events (tokens that completed their Pump.fun bonding curve and listed on Raydium). Entry score ≥ 70. Tighter exits (25-minute hold, arms at +15%, trails at 12%).

Both strategies run simultaneously in the same loop, with event routing sending each event to the right strategy automatically.

---

## Exit model

Two-phase trailing stop — avoids clipping winners short while cutting losers fast:

- **Phase 1** (below arm threshold): only the hard stop-loss fires
- **Phase 2** (once position is up past the arm threshold): trailing stop activates from the peak

Fresh launch defaults: stop-loss 20%, arm at +30%, trail 15%, hold max 60 min.  
Migration defaults: stop-loss 18%, arm at +15%, trail 12%, hold max 25 min.

---

## Quickstart

```bash
npm install
npm test
npm run bot -- --help
```

Run the continuous loop (requires PumpPortal API key):

```bash
PUMPPORTAL_API_KEY=your_key npm run bot -- run
```

---

## Commands

| Command | What it does |
|---|---|
| `run` | Main loop: watch PumpPortal, process events, manage exits, track outcomes |
| `report` | Persisted scores, open positions, closed trades, events |
| `stats` | Trade analytics: expectancy, win rate, P&L by strategy / reason / score bucket |
| `strategies` | Compact per-strategy performance table |
| `outcomes` | Counterfactual MFE/MAE for all scored candidates by score bucket |
| `tune` | Outcome data → actionable threshold recommendations with confidence ratings |
| `pump-watch` | Bounded PumpPortal listener |
| `pump-process` | Process pending events into scored candidates |
| `manage-exits` | One-shot exit pass on open positions |
| `track-outcomes` | One-shot forward price capture |
| `prune` | Delete old untraded scored candidates |
| `check-route` | Read-only Jupiter route smoke test for a token mint |

---

## Improvement cycle

```
Run paper trading 2–4 weeks
        ↓
stats + strategies → is expectancy positive?
outcomes → is the threshold set correctly?
tune → what specifically needs to change?
        ↓
Adjust config.yaml
        ↓
Repeat until consistently profitable
        ↓
Switch to live (architecture ready, execution layer not yet built)
```

---

## Safety

- `mode: paper` only — no real swaps, no wallet private keys used
- `wallet/`, `.env`, `data/`, `logs/`, `node_modules/` are git-ignored
- Never commit or log private keys, seed phrases, or API keys
