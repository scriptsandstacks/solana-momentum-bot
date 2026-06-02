// Fresh Launch Momentum — targets tokens in the first 5–90 minutes after creation
// on Pump.fun / Raydium. The edge: a small fraction of new tokens sustain buy
// pressure through their first hour and can move 200-1000%. Strict scoring
// filters out the majority that die immediately after creation.
//
// Entry: 'new_token' events from PumpPortal only (not migrations).
// Exit:  Two-phase trailing stop — hard stop-loss until +30%, then trailing from peak.
// Size:  Tiered by conviction score — larger bets when every signal aligns.

import { scoreTokenCandidate } from '../scoring/scoreToken.js';
import type { TokenCandidate } from '../types/domain.js';
import type { StrategyConfig, TradingStrategy } from './types.js';

export const FRESH_LAUNCH_MOMENTUM_STRATEGY_ID = 'freshLaunchMomentum';

export function tagFreshLaunchMomentum(candidate: TokenCandidate): TokenCandidate {
  return { ...candidate, strategyId: candidate.strategyId ?? FRESH_LAUNCH_MOMENTUM_STRATEGY_ID };
}

// Conviction tiers: score drives position size so the bot bets proportionally
// to its own signal confidence. Borderline entries (75-79) get 0.75x; strong
// signals (90+) get 1.5x. The multiplier is applied to the strategy's base
// positionSizeUsd at order time.
const SIZING_TIERS: Array<{ minScore: number; multiplier: number }> = [
  { minScore: 90, multiplier: 1.5 },
  { minScore: 80, multiplier: 1.0 },
  { minScore: 0, multiplier: 0.75 }, // 75-79 — borderline entries
];

function freshLaunchSizeMultiplier(score: number): number {
  return SIZING_TIERS.find((tier) => score >= tier.minScore)?.multiplier ?? 1.0;
}

const DEFAULT_CONFIG: StrategyConfig = {
  minScoreToEnter: 75,
  // Two-phase trailing stop defaults. The global config.yaml exits section
  // is the primary source; strategy config.exits overrides only when set.
  exits: {
    trailingArmPct: 30,
    trailingStopPct: 15,
    maxHoldMinutes: 60,
    takeProfitPct: 300, // safety ceiling — trailing stop is the real exit
  },
};

export function createFreshLaunchStrategy(config: Partial<StrategyConfig> = {}): TradingStrategy {
  const merged: StrategyConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    exits: { ...DEFAULT_CONFIG.exits, ...config.exits },
  };
  return {
    id: FRESH_LAUNCH_MOMENTUM_STRATEGY_ID,
    config: merged,
    acceptsEventType: (eventType) => eventType === 'new_token',
    tagCandidate: tagFreshLaunchMomentum,
    scoreCandidate: scoreTokenCandidate,
    resolvePositionSizeUsd: (score, baseUsd) => baseUsd * freshLaunchSizeMultiplier(score),
  };
}

// Convenience singleton with default config. Suitable for tests and scripts that
// don't need file-based config overrides.
export const freshLaunchMomentumStrategy: TradingStrategy = createFreshLaunchStrategy();
