import { describe, expect, it } from 'vitest';
import { decideExit, processExits } from '../src/bot/exitPositions.js';
import type { PaperPosition, PaperTrade, TokenCandidate } from '../src/types/domain.js';

const exits = { stopLossPct: 20, takeProfitPct: 50, trailingStopPct: 20, maxHoldMinutes: 45 };

function token(address: string): TokenCandidate {
  return {
    chain: 'solana',
    address,
    symbol: 'MOCK',
    name: 'Mock Token',
    pairAddress: `pair-${address}`,
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
}

function position(overrides: Partial<PaperPosition> & { id: string; address: string }): PaperPosition {
  const { address, ...rest } = overrides;
  return {
    token: token(address),
    score: 80,
    entryPriceUsd: 0.01,
    quantity: 2500,
    openedAt: new Date('2026-01-01T00:00:00Z'),
    highWaterMarkUsd: 0.01,
    ...rest,
  };
}

// Minimal store that satisfies both the broker-state reads and the exit writes.
function fakeStore(open: PaperPosition[]) {
  const openById = new Map(open.map((p) => [p.id, p]));
  const closed: PaperTrade[] = [];
  const saved: PaperPosition[] = [];
  return {
    loadOpenPositions: () => [...openById.values()],
    getRealizedPnlUsd: () => 0,
    getRealizedPnlUsdSince: () => 0,
    getNextPositionSeq: () => open.length + 1,
    saveClosedTrade: (trade: PaperTrade) => {
      closed.push(trade);
      openById.delete(trade.positionId);
    },
    saveOpenPosition: (p: PaperPosition) => saved.push(p),
    _closed: closed,
    _saved: saved,
  };
}

const paper = { startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 3 };
const now = new Date('2026-01-01T00:10:00Z');

describe('decideExit', () => {
  const base = { entryPriceUsd: 0.01, openedAt: new Date('2026-01-01T00:00:00Z') };

  it('takes profit at or above the take-profit threshold', () => {
    expect(decideExit({ ...base, highWaterMarkUsd: 0.016 }, 0.016, 0.016, exits, now)).toBe('take_profit');
  });

  it('stops out at or below the stop-loss threshold', () => {
    expect(decideExit({ ...base, highWaterMarkUsd: 0.01 }, 0.008, 0.01, exits, now)).toBe('stop_loss');
  });

  it('trails only after price rose above entry, firing on a drop from the peak', () => {
    // Peak 0.014 (+40%), now 0.011 — a >20% drop from peak but still above entry.
    expect(decideExit({ ...base, highWaterMarkUsd: 0.014 }, 0.011, 0.014, exits, now)).toBe('trailing_stop');
    // Same drop pattern but peak never exceeded entry → no trailing stop.
    expect(decideExit({ ...base, highWaterMarkUsd: 0.01 }, 0.0095, 0.01, exits, now)).toBeUndefined();
  });

  it('times out once max hold is exceeded with no other trigger', () => {
    const late = new Date('2026-01-01T01:00:00Z');
    expect(decideExit({ ...base, highWaterMarkUsd: 0.01 }, 0.0105, 0.0105, exits, late)).toBe('timeout');
  });

  it('returns undefined when the position is comfortably within all rules', () => {
    expect(decideExit({ ...base, highWaterMarkUsd: 0.0105 }, 0.0105, 0.0105, exits, now)).toBeUndefined();
  });
});

describe('processExits', () => {
  it('closes a position at take-profit and records the trade', async () => {
    const store = fakeStore([position({ id: 'paper-1', address: 'mint-1' })]);

    const result = await processExits({
      store,
      paper,
      exits,
      now,
      fetchPrices: async () => new Map([['mint-1', 0.016]]),
    });

    expect(result).toMatchObject({ positionsChecked: 1, repriced: 1, closed: 1, takeProfit: 1 });
    expect(store._closed).toHaveLength(1);
    expect(store._closed[0]).toMatchObject({ positionId: 'paper-1', reason: 'take_profit', exitPriceSource: 'fresh' });
    expect(store._closed[0].pnlUsd).toBeGreaterThan(0);
  });

  it('persists raised high-water and last marks when a position stays open', async () => {
    const store = fakeStore([position({ id: 'paper-1', address: 'mint-1', highWaterMarkUsd: 0.01 })]);

    const result = await processExits({
      store,
      paper,
      exits,
      now,
      fetchPrices: async () => new Map([['mint-1', 0.011]]), // +10%, no exit
    });

    expect(result).toMatchObject({ closed: 0, repriced: 1 });
    expect(store._closed).toHaveLength(0);
    expect(store._saved).toHaveLength(1);
    expect(store._saved[0].highWaterMarkUsd).toBeCloseTo(0.011);
    expect(store._saved[0].lastMarkUsd).toBeCloseTo(0.011);
  });

  it('leaves an unpriceable position open when it is within its max-hold window', async () => {
    const store = fakeStore([position({ id: 'paper-1', address: 'mint-1' })]);

    const result = await processExits({
      store,
      paper,
      exits,
      now, // openedAt + 10 min < 45 min max-hold
      fetchPrices: async () => new Map(),
    });

    expect(result).toMatchObject({ positionsChecked: 1, missingPrice: 1, closed: 0 });
    expect(store._closed).toHaveLength(0);
    expect(store._saved).toHaveLength(0);
  });

  it('times out an unpriceable position at its last known mark once max-hold passes', async () => {
    const store = fakeStore([position({ id: 'paper-1', address: 'mint-1', lastMarkUsd: 0.013 })]);
    const late = new Date('2026-01-01T01:00:00Z'); // openedAt + 60 min >= 45 min max-hold

    const result = await processExits({
      store,
      paper,
      exits,
      now: late,
      fetchPrices: async () => new Map(), // no fresh price at all
    });

    expect(result).toMatchObject({ positionsChecked: 1, missingPrice: 0, closed: 1, timeout: 1 });
    expect(store._closed).toHaveLength(1);
    expect(store._closed[0]).toMatchObject({
      positionId: 'paper-1',
      reason: 'timeout',
      exitPriceUsd: 0.013,
      exitPriceSource: 'last_mark',
    });
    // PnL is booked against the last mark, not entry: (0.013 - 0.01) * 2500 = 7.5
    expect(store._closed[0].pnlUsd).toBeCloseTo(7.5);
  });

  it('falls back to the entry price when an unpriceable position has no last mark', async () => {
    const store = fakeStore([position({ id: 'paper-1', address: 'mint-1', lastMarkUsd: undefined })]);
    const late = new Date('2026-01-01T01:00:00Z');

    const result = await processExits({
      store,
      paper,
      exits,
      now: late,
      fetchPrices: async () => new Map(),
    });

    expect(result).toMatchObject({ closed: 1, timeout: 1 });
    expect(store._closed[0]).toMatchObject({ reason: 'timeout', exitPriceUsd: 0.01, exitPriceSource: 'entry_fallback' });
    expect(store._closed[0].pnlUsd).toBeCloseTo(0);
  });
});
