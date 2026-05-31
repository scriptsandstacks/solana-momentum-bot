import type { ChainName } from '../config/schema.js';

export interface TokenCandidate {
  chain: ChainName;
  address: string;
  symbol: string;
  name: string;
  pairAddress: string;
  priceUsd: number;
  liquidityUsd: number;
  volume5mUsd: number;
  volume1hUsd: number;
  priceChange5mPct: number;
  buys5m: number;
  sells5m: number;
  ageMinutes: number;
  source: string;
  routeAvailable: boolean;
  estimatedSlippageBps: number;
  routeInputMint?: string;
  routeInputSymbol?: string;
}

export interface OpportunityScore {
  total: number;
  recommendation: 'ignore' | 'watch' | 'paper_trade';
  reasons: string[];
  risks: string[];
}

export interface PaperPosition {
  id: string;
  token: TokenCandidate;
  score: number;
  entryPriceUsd: number;
  quantity: number;
  openedAt: Date;
}

export interface PaperTrade {
  positionId: string;
  token: TokenCandidate;
  entryPriceUsd: number;
  exitPriceUsd: number;
  quantity: number;
  openedAt: Date;
  closedAt: Date;
  reason: 'stop_loss' | 'take_profit' | 'timeout' | 'manual' | 'trailing_stop';
  pnlUsd: number;
  pnlPct: number;
}
