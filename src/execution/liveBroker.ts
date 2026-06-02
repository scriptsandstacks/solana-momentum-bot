import type { ChainConfig } from '../config/schema.js';
import type { PaperPosition, PaperTrade, TokenCandidate } from '../types/domain.js';
import type { ExecutionBroker } from './broker.js';

export interface LiveBrokerOptions {
  solana: ChainConfig;
}

// Scaffold only: this preserves the paper/live broker seam without enabling
// live transaction submission yet. Do not load private keys or sign here until
// the real Jupiter transaction path is implemented deliberately.
export class LiveBroker implements ExecutionBroker {
  readonly mode = 'live' as const;

  constructor(private readonly options: LiveBrokerOptions) {}

  canOpenPosition(): { ok: boolean; reason?: string } {
    return { ok: false, reason: 'LiveBroker is scaffolded but trade execution is not implemented yet' };
  }

  openPosition(_candidate: TokenCandidate, _score: number): PaperPosition {
    throw this.notImplemented();
  }

  recordMark(_positionId: string, _priceUsd: number): PaperPosition {
    throw this.notImplemented();
  }

  closePosition(_positionId: string, _exitPriceUsd: number, _reason: PaperTrade['reason']): PaperTrade {
    throw this.notImplemented();
  }

  getCashUsd(): number {
    return 0;
  }

  getRealizedPnlUsd(): number {
    return 0;
  }

  getDailyRealizedPnlUsd(): number {
    return 0;
  }

  getOpenPositions(): PaperPosition[] {
    return [];
  }

  getClosedTrades(): PaperTrade[] {
    return [];
  }

  describeReadiness(): string {
    const wallet = this.options.solana.walletFile ?? 'not configured';
    return `LiveBroker scaffold configured for Solana walletFile=${wallet}; execution not implemented`;
  }

  private notImplemented(): Error {
    return new Error('LiveBroker execution is not implemented yet; no live transaction was submitted');
  }
}
