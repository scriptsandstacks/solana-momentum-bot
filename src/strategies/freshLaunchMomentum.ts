import type { TokenCandidate } from '../types/domain.js';

export const FRESH_LAUNCH_MOMENTUM_STRATEGY_ID = 'freshLaunchMomentum';

export function tagFreshLaunchMomentum(candidate: TokenCandidate): TokenCandidate {
  return { ...candidate, strategyId: candidate.strategyId ?? FRESH_LAUNCH_MOMENTUM_STRATEGY_ID };
}
