import type { PaperPosition, PaperTrade, TokenCandidate } from '../types/domain.js';

export interface PaperBrokerOptions {
  startingBalanceUsd: number;
  positionSizeUsd: number;
  maxOpenPositions: number;
  // Optional daily realized-loss circuit breaker. When today's net realized
  // PnL drops to -maxDailyLossUsd or worse, no new positions may be opened
  // until the next UTC day. Exits are never blocked.
  maxDailyLossUsd?: number;
}

export interface PaperBrokerState {
  openPositions: PaperPosition[];
  // Total realized PnL across every closed trade so far. Used to reconstruct
  // cash without persisting cash directly: every open deducts positionSizeUsd
  // and every close returns exit value, so cash collapses to
  // startingBalance + realizedPnl - positionSizeUsd * openCount.
  realizedPnlUsd: number;
  // Realized PnL booked during the current UTC day, used to seed the breaker.
  dailyRealizedPnlUsd: number;
  // Next sequence number for generated position ids, so restored ids never collide.
  nextPositionSeq: number;
}

export interface OpenPositionCheck {
  ok: boolean;
  reason?: string;
}

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class PaperBroker {
  private cashUsd: number;
  private readonly positionSizeUsd: number;
  private readonly maxOpenPositions: number;
  private readonly maxDailyLossUsd?: number;
  private readonly openPositions = new Map<string, PaperPosition>();
  private readonly closedTrades: PaperTrade[] = [];
  // Realized PnL bucketed by UTC day so the daily breaker resets across day
  // boundaries even during a long-running process.
  private readonly dailyPnlByDay = new Map<string, number>();
  private realizedPnlUsd = 0;
  private nextId = 1;

  constructor(options: PaperBrokerOptions) {
    this.cashUsd = options.startingBalanceUsd;
    this.positionSizeUsd = options.positionSizeUsd;
    this.maxOpenPositions = options.maxOpenPositions;
    this.maxDailyLossUsd = options.maxDailyLossUsd;
  }

  // Rebuild a broker from persisted state so cash, open positions, the daily
  // loss breaker, and the position-id sequence survive across passes/restarts.
  static restore(options: PaperBrokerOptions, state: PaperBrokerState): PaperBroker {
    const broker = new PaperBroker(options);
    broker.realizedPnlUsd = state.realizedPnlUsd;
    broker.cashUsd =
      options.startingBalanceUsd + state.realizedPnlUsd - options.positionSizeUsd * state.openPositions.length;
    broker.nextId = Math.max(1, state.nextPositionSeq);
    for (const position of state.openPositions) {
      broker.openPositions.set(position.id, position);
    }
    if (state.dailyRealizedPnlUsd !== 0) {
      broker.dailyPnlByDay.set(utcDayKey(new Date()), state.dailyRealizedPnlUsd);
    }
    return broker;
  }

  canOpenPosition(now = new Date()): OpenPositionCheck {
    if (this.openPositions.size >= this.maxOpenPositions) {
      return { ok: false, reason: `Cannot open position: max open positions (${this.maxOpenPositions}) reached` };
    }
    if (this.cashUsd < this.positionSizeUsd) {
      return { ok: false, reason: 'Cannot open position: insufficient paper cash' };
    }
    if (this.maxDailyLossUsd !== undefined) {
      const todayPnl = this.dailyPnlByDay.get(utcDayKey(now)) ?? 0;
      if (todayPnl <= -this.maxDailyLossUsd) {
        return { ok: false, reason: `Cannot open position: daily loss limit ($${this.maxDailyLossUsd}) reached` };
      }
    }
    return { ok: true };
  }

  openPosition(candidate: TokenCandidate, score: number, openedAt = new Date()): PaperPosition {
    const check = this.canOpenPosition(openedAt);
    if (!check.ok) {
      throw new Error(check.reason);
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
      highWaterMarkUsd: candidate.priceUsd,
    };

    this.cashUsd -= this.positionSizeUsd;
    this.openPositions.set(id, position);
    return position;
  }

  // Raise the recorded high-water mark when a fresh price exceeds it. Returns
  // the (possibly updated) position so callers can persist the new mark.
  updateHighWaterMark(positionId: string, priceUsd: number): PaperPosition {
    const position = this.openPositions.get(positionId);
    if (!position) {
      throw new Error(`Cannot update position: unknown position ${positionId}`);
    }
    if (priceUsd > position.highWaterMarkUsd) {
      position.highWaterMarkUsd = priceUsd;
    }
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
    this.realizedPnlUsd += pnlUsd;
    const dayKey = utcDayKey(closedAt);
    this.dailyPnlByDay.set(dayKey, (this.dailyPnlByDay.get(dayKey) ?? 0) + pnlUsd);
    return trade;
  }

  getCashUsd(): number {
    return this.cashUsd;
  }

  getRealizedPnlUsd(): number {
    return this.realizedPnlUsd;
  }

  getDailyRealizedPnlUsd(now = new Date()): number {
    return this.dailyPnlByDay.get(utcDayKey(now)) ?? 0;
  }

  getOpenPositions(): PaperPosition[] {
    return [...this.openPositions.values()];
  }

  getClosedTrades(): PaperTrade[] {
    return [...this.closedTrades];
  }
}
