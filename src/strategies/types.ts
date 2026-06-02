import type { TokenCandidate } from '../types/domain.js';

// Per-strategy entry and exit parameters. Strategies carry their own config so
// two strategies can run with different thresholds without coupling them to the
// global config section. The CLI merges global config values as the initial
// source; individual strategies may tighten or relax from those defaults.
export interface StrategyConfig {
  minScoreToEnter: number;
  exits?: {
    stopLossPct?: number;
    takeProfitPct?: number;
    trailingStopPct?: number;
    maxHoldMinutes?: number;
  };
}

export interface TradingStrategy {
  id: string;
  config: StrategyConfig;
  tagCandidate(candidate: TokenCandidate): TokenCandidate;
}
