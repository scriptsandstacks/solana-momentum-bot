import type { TokenCandidate } from '../types/domain.js';

export interface TradingStrategy {
  id: string;
  tagCandidate(candidate: TokenCandidate): TokenCandidate;
}
