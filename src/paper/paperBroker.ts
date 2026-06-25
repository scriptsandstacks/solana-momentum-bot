import type { ExecutionBroker } from '../execution/broker.js';
import type { PaperPosition, PaperTrade, TokenCandidate } from '../types/domain.js';

export interface PaperBrokerOptions {
  startingBalanceUsd: number;
  positionSizeUsd: number;
  maxOpenPositions: number;
  // Optional daily realized-loss circuit breaker. When today's net realized
  // PnL drops to -maxDailyLossUsd or worse, no new positions may be opened
  // until the next UTC day. Exits are never blocked.
  maxDailyLossUsd?: number;
  // Optional trading-cost model. When present, fills are worsened to reflect
  // real swap friction so paper PnL is not frictionless fantasy:
  //   - feeBps is charged on every leg (entry and exit) for swap + priority fees;
  //   - applyRouteSlippage additionally charges the candidate's
  //     estimatedSlippageBps (route price impact) on each leg.
  // Entry: you receive fewer tokens (effective buy price > mid). Exit: proceeds
  // are reduced (effective sell price < mark). When omitted, fills are
  // frictionless (mid price, no fees) — the historical behavior.
  costModel?: {
    feeBps: number;
    applyRouteSlippage: boolean;
  };
}

export interface PaperBrokerState {
  openPositions: PaperPosition[];
  // Total realized PnL across every closed trade so far. Used to reconstruct
  // cash without persisting cash directly: every open deducts its actual
  // persisted entry value and every close returns exit value, so cash collapses to
  // startingBalance + realizedPnl - sum(open entryPriceUsd * quantity).
  realizedPnlUsd: number;
  // Realized PnL booked during the current UTC day, used to seed the breaker.
  dailyRealizedPnlUsd: number;
  // Day associated with dailyRealizedPnlUsd. restoreBrokerFromStore passes the
  // same clock used to compute the since-start-of-day query so restored breaker
  // state is deterministic in tests and across timezones/processes.
  dailyRealizedPnlAt?: Date;
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

export class PaperBroker implements ExecutionBroker {
  readonly mode = 'paper' as const;
  private cashUsd: number;
  private readonly positionSizeUsd: number;
  private readonly maxOpenPositions: number;
  private readonly maxDailyLossUsd?: number;
  private readonly costModel?: PaperBrokerOptions['costModel'];
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
    this.costModel = options.costModel;
  }

  // Fraction of price lost to friction on a single leg (entry or exit). Clamped
  // below 1 so an effective sell price stays positive and a buy price finite.
  private legCostFraction(estimatedSlippageBps: number): number {
    if (!this.costModel) return 0;
    const slippageBps = this.costModel.applyRouteSlippage ? Math.max(0, estimatedSlippageBps) : 0;
    return Math.min(0.99, (slippageBps + this.costModel.feeBps) / 10_000);
  }

  // Rebuild a broker from persisted state so cash, open positions, the daily
  // loss breaker, and the position-id sequence survive across passes/restarts.
  static restore(options: PaperBrokerOptions, state: PaperBrokerState): PaperBroker {
    const broker = new PaperBroker(options);
    broker.realizedPnlUsd = state.realizedPnlUsd;
    const openPositionValueUsd = state.openPositions.reduce(
      (total, position) => total + position.entryPriceUsd * position.quantity,
      0,
    );
    broker.cashUsd = options.startingBalanceUsd + state.realizedPnlUsd - openPositionValueUsd;
    broker.nextId = Math.max(1, state.nextPositionSeq);
    for (const position of state.openPositions) {
      broker.openPositions.set(position.id, position);
    }
    if (state.dailyRealizedPnlUsd !== 0) {
      broker.dailyPnlByDay.set(utcDayKey(state.dailyRealizedPnlAt ?? new Date()), state.dailyRealizedPnlUsd);
    }
    return broker;
  }

  canOpenPosition(now = new Date(), requiredSizeUsd?: number): OpenPositionCheck {
    return this.canOpenPositionForCandidate(undefined, now, requiredSizeUsd);
  }

  canOpenPositionForCandidate(candidate?: TokenCandidate, now = new Date(), requiredSizeUsd?: number): OpenPositionCheck {
    if (this.openPositions.size >= this.maxOpenPositions) {
      return { ok: false, reason: `Cannot open position: max open positions (${this.maxOpenPositions}) reached` };
    }
    if (candidate && [...this.openPositions.values()].some((position) => position.token.address === candidate.address)) {
      return { ok: false, reason: `Cannot open position: ${candidate.symbol} already has open exposure` };
    }
    const required = requiredSizeUsd ?? this.positionSizeUsd;
    if (this.cashUsd < required) {
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

  // positionSizeUsd overrides the broker's configured base size for this specific
  // trade. Use this for conviction-tiered sizing: pass strategy.resolvePositionSizeUsd()
  // output here rather than changing the broker's global configuration.
  async openPosition(candidate: TokenCandidate, score: number, openedAt = new Date(), positionSizeUsd?: number): Promise<PaperPosition> {
    const check = this.canOpenPositionForCandidate(candidate, openedAt);
    if (!check.ok) {
      throw new Error(check.reason);
    }
    if (candidate.priceUsd <= 0) {
      throw new Error('Cannot open position: candidate price must be positive');
    }

    const id = `paper-${this.nextId++}`;
    // The effective buy price is the mid worsened by entry-leg friction, so the
    // same positionSizeUsd buys fewer tokens. entryPriceUsd records this actual
    // fill (exit-rule PnL is then measured against what we really paid), while
    // the high-water and last marks track the observed mid for trailing stops.
    const sizeUsd = positionSizeUsd ?? this.positionSizeUsd;
    const costFraction = this.legCostFraction(candidate.estimatedSlippageBps);
    const effectiveEntryPriceUsd = candidate.priceUsd * (1 + costFraction);
    const quantity = sizeUsd / effectiveEntryPriceUsd;
    const position: PaperPosition = {
      id,
      token: candidate,
      score,
      entryPriceUsd: effectiveEntryPriceUsd,
      quantity,
      openedAt,
      highWaterMarkUsd: candidate.priceUsd,
      lastMarkUsd: candidate.priceUsd,
    };

    this.cashUsd -= sizeUsd;
    this.openPositions.set(id, position);
    return position;
  }

  // Record a fresh observed price: always update the last-mark, and ratchet the
  // high-water mark up when the price exceeds it. Returns the position so callers
  // can persist the new marks.
  recordMark(positionId: string, priceUsd: number): PaperPosition {
    const position = this.openPositions.get(positionId);
    if (!position) {
      throw new Error(`Cannot update position: unknown position ${positionId}`);
    }
    position.lastMarkUsd = priceUsd;
    if (priceUsd > position.highWaterMarkUsd) {
      position.highWaterMarkUsd = priceUsd;
    }
    return position;
  }

  async closePosition(
    positionId: string,
    exitPriceUsd: number,
    reason: PaperTrade['reason'],
    closedAt = new Date(),
    exitPriceSource: NonNullable<PaperTrade['exitPriceSource']> = 'fresh',
    // Fresh sell-direction price impact (bps) for the exit leg. When provided it
    // overrides the position's entry-time route estimate, which was a small
    // buy-side probe and a poor proxy for selling the full position later.
    exitSlippageBps?: number,
  ): Promise<PaperTrade> {
    const position = this.openPositions.get(positionId);
    if (!position) {
      throw new Error(`Cannot close position: unknown position ${positionId}`);
    }
    if (exitPriceUsd <= 0) {
      throw new Error('Cannot close position: exit price must be positive');
    }

    // Worsen the realized sell price by exit-leg friction. The recorded
    // exitPriceUsd is this net price, so persisted PnL and cash reflect what the
    // position would actually have fetched, not the frictionless mark. A fresh
    // sell-side slippage estimate is preferred over the stale entry probe.
    const costFraction = this.legCostFraction(exitSlippageBps ?? position.token.estimatedSlippageBps);
    const netExitPriceUsd = exitPriceUsd * (1 - costFraction);
    const entryValueUsd = position.entryPriceUsd * position.quantity;
    const exitValueUsd = netExitPriceUsd * position.quantity;
    const pnlUsd = exitValueUsd - entryValueUsd;
    const pnlPct = (pnlUsd / entryValueUsd) * 100;

    const trade: PaperTrade = {
      positionId,
      token: position.token,
      score: position.score,
      entryPriceUsd: position.entryPriceUsd,
      exitPriceUsd: netExitPriceUsd,
      quantity: position.quantity,
      openedAt: position.openedAt,
      closedAt,
      reason,
      exitPriceSource,
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
