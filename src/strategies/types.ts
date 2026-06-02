import type { OpportunityScore, TokenCandidate } from '../types/domain.js';

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
    trailingArmPct?: number;
    maxHoldMinutes?: number;
  };
}

export interface TradingStrategy {
  id: string;
  config: StrategyConfig;
  // Tag a candidate with this strategy's ID after it passes discovery.
  tagCandidate(candidate: TokenCandidate): TokenCandidate;
  // Score a candidate using this strategy's own signal weights and risk model.
  // Strategies define their own scoring logic so a second strategy (e.g. mean
  // reversion) can weight signals differently without touching the global scorer.
  scoreCandidate(candidate: TokenCandidate): OpportunityScore;
}
