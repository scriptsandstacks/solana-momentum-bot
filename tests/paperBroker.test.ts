import { describe, expect, it } from 'vitest';
import { PaperBroker } from '../src/paper/paperBroker.js';
import type { TokenCandidate } from '../src/types/domain.js';

const candidate: TokenCandidate = {
  chain: 'solana',
  address: 'token-1',
  symbol: 'MOCK',
  name: 'Mock Token',
  pairAddress: 'pair-1',
  priceUsd: 0.01,
  liquidityUsd: 50_000,
  volume5mUsd: 15_000,
  volume1hUsd: 100_000,
  priceChange5mPct: 8,
  buys5m: 80,
  sells5m: 30,
  ageMinutes: 15,
  source: 'test',
  routeAvailable: true,
  estimatedSlippageBps: 100,
};

describe('PaperBroker', () => {
  it('opens a paper position and deducts cash', () => {
    const broker = new PaperBroker({ startingBalanceUsd: 100, positionSizeUsd: 25, maxOpenPositions: 3 });

    const position = broker.openPosition(candidate, 82, new Date('2026-01-01T00:00:00Z'));

    expect(position.entryPriceUsd).toBe(0.01);
    expect(position.quantity).toBe(2500);
    expect(broker.getCashUsd()).toBe(75);
    expect(broker.getOpenPositions()).toHaveLength(1);
  });

  it('closes a paper position and records pnl', () => {
    const broker = new PaperBroker({ startingBalanceUsd: 100, positionSizeUsd: 25, maxOpenPositions: 3 });
    const position = broker.openPosition(candidate, 82, new Date('2026-01-01T00:00:00Z'));

    const trade = broker.closePosition(position.id, 0.015, 'take_profit', new Date('2026-01-01T00:05:00Z'));

    expect(trade.pnlUsd).toBeCloseTo(12.5);
    expect(trade.pnlPct).toBeCloseTo(50);
    expect(broker.getCashUsd()).toBeCloseTo(112.5);
    expect(broker.getOpenPositions()).toHaveLength(0);
    expect(broker.getClosedTrades()).toHaveLength(1);
  });

  it('refuses to exceed max open positions', () => {
    const broker = new PaperBroker({ startingBalanceUsd: 100, positionSizeUsd: 25, maxOpenPositions: 1 });
    broker.openPosition(candidate, 82, new Date('2026-01-01T00:00:00Z'));

    expect(() => broker.openPosition({ ...candidate, address: 'token-2', pairAddress: 'pair-2' }, 80, new Date('2026-01-01T00:01:00Z'))).toThrow(/max open/i);
  });

  it('initializes the high-water mark to entry and only ratchets upward', () => {
    const broker = new PaperBroker({ startingBalanceUsd: 100, positionSizeUsd: 25, maxOpenPositions: 3 });
    const position = broker.openPosition(candidate, 82, new Date('2026-01-01T00:00:00Z'));

    expect(position.highWaterMarkUsd).toBe(0.01);
    expect(broker.updateHighWaterMark(position.id, 0.02).highWaterMarkUsd).toBe(0.02);
    // A lower print must not lower the mark.
    expect(broker.updateHighWaterMark(position.id, 0.015).highWaterMarkUsd).toBe(0.02);
  });

  it('blocks new entries once the daily loss limit is reached, but still allows exits', () => {
    const broker = new PaperBroker({
      startingBalanceUsd: 1000,
      positionSizeUsd: 100,
      maxOpenPositions: 5,
      maxDailyLossUsd: 50,
    });
    const position = broker.openPosition(candidate, 82, new Date('2026-01-01T00:00:00Z'));
    // Close at a 60% loss: -$60 realized, past the $50 daily limit.
    broker.closePosition(position.id, 0.004, 'stop_loss', new Date('2026-01-01T00:05:00Z'));

    expect(broker.getDailyRealizedPnlUsd(new Date('2026-01-01T01:00:00Z'))).toBeCloseTo(-60);
    const check = broker.canOpenPosition(new Date('2026-01-01T01:00:00Z'));
    expect(check.ok).toBe(false);
    expect(check.reason).toMatch(/daily loss/i);
    expect(() => broker.openPosition(candidate, 82, new Date('2026-01-01T01:00:00Z'))).toThrow(/daily loss/i);

    // The breaker is scoped to the day the loss was booked: the next UTC day is clear.
    expect(broker.canOpenPosition(new Date('2026-01-02T00:00:00Z')).ok).toBe(true);
  });

  it('restores cash, open positions, breaker state, and the id sequence', () => {
    const restored = PaperBroker.restore(
      { startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 3, maxDailyLossUsd: 50 },
      {
        openPositions: [
          {
            id: 'paper-7',
            token: candidate,
            score: 80,
            entryPriceUsd: 0.01,
            quantity: 2500,
            openedAt: new Date('2026-01-01T00:00:00Z'),
            highWaterMarkUsd: 0.012,
          },
        ],
        realizedPnlUsd: 12.5,
        dailyRealizedPnlUsd: -60,
        nextPositionSeq: 8,
      },
    );

    // cash = start(1000) + realized(12.5) - size(25) * openCount(1)
    expect(restored.getCashUsd()).toBeCloseTo(987.5);
    expect(restored.getOpenPositions()).toHaveLength(1);
    expect(restored.canOpenPosition().reason).toMatch(/daily loss/i);
    // New positions continue the persisted sequence rather than colliding with paper-7.
    const next = restored.openPosition(
      { ...candidate, address: 'token-9', pairAddress: 'pair-9' },
      80,
      new Date('2026-01-02T00:00:00Z'),
    );
    expect(next.id).toBe('paper-8');
  });
});
