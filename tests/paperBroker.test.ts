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
});
