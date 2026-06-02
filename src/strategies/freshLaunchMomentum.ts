import { scoreTokenCandidate } from '../scoring/scoreToken.js';
import type { TokenCandidate } from '../types/domain.js';
import type { StrategyConfig, TradingStrategy } from './types.js';

export const FRESH_LAUNCH_MOMENTUM_STRATEGY_ID = 'freshLaunchMomentum';

export function tagFreshLaunchMomentum(candidate: TokenCandidate): TokenCandidate {
  return { ...candidate, strategyId: candidate.strategyId ?? FRESH_LAUNCH_MOMENTUM_STRATEGY_ID };
}

// Default config for fresh-launch momentum. These match the current global
// config defaults so the strategy is opinionated but overridable at construction.
const DEFAULT_CONFIG: StrategyConfig = {
  minScoreToEnter: 75,
};

// Factory: creates a strategy object with config sourced from the caller's
// settings. Use this at CLI startup to merge file-based config into the strategy.
export function createFreshLaunchStrategy(config: Partial<StrategyConfig> = {}): TradingStrategy {
  return {
    id: FRESH_LAUNCH_MOMENTUM_STRATEGY_ID,
    config: { ...DEFAULT_CONFIG, ...config },
    tagCandidate: tagFreshLaunchMomentum,
    scoreCandidate: scoreTokenCandidate,
  };
}

// Convenience singleton with default config. Suitable for tests and scripts that
// don't need file-based config overrides.
export const freshLaunchMomentumStrategy: TradingStrategy = createFreshLaunchStrategy();
