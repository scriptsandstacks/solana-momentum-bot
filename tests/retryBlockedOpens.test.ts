import { describe, expect, it } from 'vitest';
import { retryBlockedOpens } from '../src/bot/retryBlockedOpens.js';
import type { RetriableScoredCandidateRow } from '../src/storage/sqliteStore.js';
import type { PaperPosition } from '../src/types/domain.js';

const CUTOFF = '2026-01-01T00:00:00.000Z';

function row(overrides: Partial<RetriableScoredCandidateRow> = {}): RetriableScoredCandidateRow {
  return {
    chain: 'solana',
    address: 'mint-1',
    symbol: 'TEST',
    name: 'Test Token',
    pairAddress: 'pair-1',
    priceUsd: 0.01,
    liquidityUsd: 50_000,
    volume5mUsd: 20_000,
    volume1hUsd: 100_000,
    priceChange5mPct: 12,
    buys5m: 80,
    sells5m: 30,
    ageMinutes: 15,
    source: 'test',
    routeAvailable: 1,
    estimatedSlippageBps: 100,
    routeInputMint: 'usdc-mint',
    routeInputSymbol: 'USDC',
    sellRouteAvailable: 1,
    score: 85,
    ...overrides,
  };
}

function fakeStore(retriable: RetriableScoredCandidateRow[], openPositions: PaperPosition[] = []) {
  const saved: PaperPosition[] = [];
  return {
    listRetriableScoredCandidates: () => retriable,
    saveOpenPosition: (pos: PaperPosition) => saved.push(pos),
    loadOpenPositions: () => openPositions,
    getRealizedPnlUsd: () => 0,
    getRealizedPnlUsdSince: () => 0,
    getNextPositionSeq: () => openPositions.length,
    _saved: saved,
  };
}

const paper = { startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 3 };

describe('retryBlockedOpens', () => {
  it('opens positions for retriable candidates when broker has capacity', async () => {
    const store = fakeStore([row({ address: 'mint-1' }), row({ address: 'mint-2' })]);

    const result = await retryBlockedOpens({ store, paper, minimumScoreToEnter: 75, cutoffIso: CUTOFF });

    expect(result.candidates).toBe(2);
    expect(result.openedPositions).toBe(2);
    expect(store._saved).toHaveLength(2);
    expect(store._saved[0].token.address).toBe('mint-1');
    expect(store._saved[1].token.address).toBe('mint-2');
  });

  it('stops opening once broker capacity is reached', async () => {
    // 3 retriable candidates but cap is 1 (2 already open)
    const occupied: PaperPosition[] = [
      { id: 'paper-0', token: row() as any, score: 80, entryPriceUsd: 0.01, quantity: 2500, openedAt: new Date(), highWaterMarkUsd: 0.01 },
      { id: 'paper-1', token: row() as any, score: 80, entryPriceUsd: 0.01, quantity: 2500, openedAt: new Date(), highWaterMarkUsd: 0.01 },
    ];
    const store = fakeStore([row({ address: 'a' }), row({ address: 'b' }), row({ address: 'c' })], occupied);

    const result = await retryBlockedOpens({ store, paper, minimumScoreToEnter: 75, cutoffIso: CUTOFF });

    expect(result.openedPositions).toBe(1);
    expect(store._saved).toHaveLength(1);
  });

  it('returns zero opened when no retriable candidates exist', async () => {
    const store = fakeStore([]);

    const result = await retryBlockedOpens({ store, paper, minimumScoreToEnter: 75, cutoffIso: CUTOFF });

    expect(result.candidates).toBe(0);
    expect(result.openedPositions).toBe(0);
    expect(store._saved).toHaveLength(0);
  });

  it('maps sellRouteAvailable tristate correctly onto the opened candidate', async () => {
    const store = fakeStore([row({ sellRouteAvailable: 0 })]);

    await retryBlockedOpens({ store, paper, minimumScoreToEnter: 75, cutoffIso: CUTOFF });

    expect(store._saved[0].token.sellRouteAvailable).toBe(false);
  });
});
