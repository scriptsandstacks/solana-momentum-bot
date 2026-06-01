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
  // Populated after a Jupiter sell probe; absent on raw DexScreener/Raydium candidates.
  // false means the sell route was checked and failed — strong honeypot signal.
  sellRouteAvailable?: boolean;
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
  // Highest price observed since entry, used to evaluate trailing stops.
  // Initialized to the entry price when the position is opened.
  highWaterMarkUsd: number;
  // Most recent observed price (unlike the high-water mark, this is not
  // ratcheted — it always reflects the latest reprice). Used as the exit price
  // when a max-hold timeout fires on a pass where no fresh price is available.
  // Optional for backward compatibility; reads fall back to the entry price.
  lastMarkUsd?: number;
}

export interface PaperTrade {
  positionId: string;
  token: TokenCandidate;
  // Entry score that opened the position, carried onto the closed trade so
  // performance can be analyzed by score bucket. Optional for backward
  // compatibility with older callers/tests; broker closes populate it.
  score?: number;
  entryPriceUsd: number;
  exitPriceUsd: number;
  quantity: number;
  openedAt: Date;
  closedAt: Date;
  reason: 'stop_loss' | 'take_profit' | 'timeout' | 'manual' | 'trailing_stop';
  // Explains whether the recorded exit price came from a fresh market print or
  // from stale/fallback timeout policy. Useful for reports so stale timeout PnL
  // is visibly different from normal price-triggered exits.
  exitPriceSource?: 'fresh' | 'last_mark' | 'entry_fallback';
  pnlUsd: number;
  pnlPct: number;
}
