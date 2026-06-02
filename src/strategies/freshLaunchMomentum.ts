import type { TokenCandidate } from '../types/domain.js';
import type { TradingStrategy } from './types.js';

export const FRESH_LAUNCH_MOMENTUM_STRATEGY_ID = 'freshLaunchMomentum';

export function tagFreshLaunchMomentum(candidate: TokenCandidate): TokenCandidate {
  return { ...candidate, strategyId: candidate.strategyId ?? FRESH_LAUNCH_MOMENTUM_STRATEGY_ID };
}

export const freshLaunchMomentumStrategy: TradingStrategy = {
  id: FRESH_LAUNCH_MOMENTUM_STRATEGY_ID,
  tagCandidate: tagFreshLaunchMomentum,
};
