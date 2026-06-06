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
  // Strategy that produced/owns this candidate once it has passed through a strategy module.
  // Raw discovery candidates may omit it; current PumpPortal flow tags freshLaunchMomentum.
  strategyId?: string;
  // Populated after a Jupiter sell probe; absent on raw DexScreener/Raydium candidates.
  // false means the sell route was checked and failed — strong honeypot signal.
  sellRouteAvailable?: boolean;
  // Populated after a Solana RPC mint-account inspection.
  // true  = authority revoked (safe); false = authority still held (rug risk); undefined = not checked.
  mintAuthorityRevoked?: boolean;
  freezeAuthorityRevoked?: boolean;
  // Percentage of token supply held by the largest five token accounts.
  // undefined = not checked or RPC failure.
  top5HolderPct?: number;
  // Computed from recent per-token volume snapshots before the current score is saved.
  // undefined = insufficient history; samples records how much history was available.
  volumeAcceleration5mZ?: number;
  volumeAccelerationSamples?: number;
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
  // Solana transaction signature for the entry swap. Populated only in live mode;
  // undefined in paper mode. Useful for on-chain verification and audit logs.
  entryTxSignature?: string;
  // USD value of the Solana network fee paid for the entry transaction.
  // Persisted on open positions so restarts preserve the true live cost basis.
  entryNetworkFeeUsd?: number;
  entryNetworkFeeLamports?: number;
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
  // Solana transaction signature for the exit swap. Populated only in live mode.
  exitTxSignature?: string;
  // Solana network fees valued in USD at execution time. Undefined in paper mode.
  entryNetworkFeeUsd?: number;
  exitNetworkFeeUsd?: number;
  entryNetworkFeeLamports?: number;
  exitNetworkFeeLamports?: number;
}
