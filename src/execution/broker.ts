import type { PaperPosition, PaperTrade, TokenCandidate } from '../types/domain.js';

// The contract between bot logic (entry decisions, exit rules) and an execution
// engine. PaperBroker implements this for simulation. A future LiveBroker will
// implement it by submitting real on-chain transactions so the bot logic is
// identical in both modes — only the broker swaps out.
export interface ExecutionBroker {
  readonly mode: 'paper' | 'live';
  canOpenPosition(now?: Date, requiredSizeUsd?: number): { ok: boolean; reason?: string };
  // positionSizeUsd overrides the broker's configured base size for this trade,
  // allowing strategies to size up high-conviction trades and size down borderline ones.
  openPosition(candidate: TokenCandidate, score: number, openedAt?: Date, positionSizeUsd?: number): PaperPosition;
  recordMark(positionId: string, priceUsd: number): PaperPosition;
  closePosition(
    positionId: string,
    exitPriceUsd: number,
    reason: PaperTrade['reason'],
    closedAt?: Date,
    exitPriceSource?: NonNullable<PaperTrade['exitPriceSource']>,
    exitSlippageBps?: number,
  ): PaperTrade;
  getCashUsd(): number;
  getRealizedPnlUsd(): number;
  getDailyRealizedPnlUsd(now?: Date): number;
  getOpenPositions(): PaperPosition[];
  getClosedTrades(): PaperTrade[];
}
