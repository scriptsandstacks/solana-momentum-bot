import type { PaperPosition, PaperTrade, TokenCandidate } from '../types/domain.js';

interface PaperBrokerOptions {
  startingBalanceUsd: number;
  positionSizeUsd: number;
  maxOpenPositions: number;
}

export class PaperBroker {
  private cashUsd: number;
  private readonly positionSizeUsd: number;
  private readonly maxOpenPositions: number;
  private readonly openPositions = new Map<string, PaperPosition>();
  private readonly closedTrades: PaperTrade[] = [];
  private nextId = 1;

  constructor(options: PaperBrokerOptions) {
    this.cashUsd = options.startingBalanceUsd;
    this.positionSizeUsd = options.positionSizeUsd;
    this.maxOpenPositions = options.maxOpenPositions;
  }

  openPosition(candidate: TokenCandidate, score: number, openedAt = new Date()): PaperPosition {
    if (this.openPositions.size >= this.maxOpenPositions) {
      throw new Error(`Cannot open position: max open positions (${this.maxOpenPositions}) reached`);
    }
    if (this.cashUsd < this.positionSizeUsd) {
      throw new Error('Cannot open position: insufficient paper cash');
    }
    if (candidate.priceUsd <= 0) {
      throw new Error('Cannot open position: candidate price must be positive');
    }

    const id = `paper-${this.nextId++}`;
    const quantity = this.positionSizeUsd / candidate.priceUsd;
    const position: PaperPosition = {
      id,
      token: candidate,
      score,
      entryPriceUsd: candidate.priceUsd,
      quantity,
      openedAt,
    };

    this.cashUsd -= this.positionSizeUsd;
    this.openPositions.set(id, position);
    return position;
  }

  closePosition(
    positionId: string,
    exitPriceUsd: number,
    reason: PaperTrade['reason'],
    closedAt = new Date(),
  ): PaperTrade {
    const position = this.openPositions.get(positionId);
    if (!position) {
      throw new Error(`Cannot close position: unknown position ${positionId}`);
    }
    if (exitPriceUsd <= 0) {
      throw new Error('Cannot close position: exit price must be positive');
    }

    const entryValueUsd = position.entryPriceUsd * position.quantity;
    const exitValueUsd = exitPriceUsd * position.quantity;
    const pnlUsd = exitValueUsd - entryValueUsd;
    const pnlPct = (pnlUsd / entryValueUsd) * 100;

    const trade: PaperTrade = {
      positionId,
      token: position.token,
      entryPriceUsd: position.entryPriceUsd,
      exitPriceUsd,
      quantity: position.quantity,
      openedAt: position.openedAt,
      closedAt,
      reason,
      pnlUsd,
      pnlPct,
    };

    this.openPositions.delete(positionId);
    this.closedTrades.push(trade);
    this.cashUsd += exitValueUsd;
    return trade;
  }

  getCashUsd(): number {
    return this.cashUsd;
  }

  getOpenPositions(): PaperPosition[] {
    return [...this.openPositions.values()];
  }

  getClosedTrades(): PaperTrade[] {
    return [...this.closedTrades];
  }
}
