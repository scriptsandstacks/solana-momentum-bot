import { describe, expect, it } from 'vitest';
import { runPaperCycle } from '../src/bot/paperCycle.js';
import type { PaperPosition, TokenCandidate } from '../src/types/domain.js';

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

describe('runPaperCycle', () => {
  it('scores candidates, persists them, and opens qualifying paper positions', async () => {
    const savedScores: string[] = [];
    const savedPositions: string[] = [];

    const result = await runPaperCycle({
      candidates: [candidate],
      paper: { startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 3 },
      minimumScoreToEnter: 75,
      store: {
        saveScoredCandidate: (token, score) => savedScores.push(`${token.symbol}:${score.total}`),
        saveOpenPosition: (position) => savedPositions.push(position.token.symbol),
      },
    });

    expect(result.scored).toHaveLength(1);
    expect(savedScores).toEqual(['MOCK:94']);
    expect(savedPositions).toEqual(['MOCK']);
    expect(result.broker.getOpenPositions()).toHaveLength(1);
  });

  it('keeps scoring every candidate even after the position cap is hit', async () => {
    const savedScores: string[] = [];
    const savedPositions: string[] = [];

    const candidates = [
      { ...candidate, address: 'token-1', symbol: 'AAA', pairAddress: 'pair-1' },
      { ...candidate, address: 'token-2', symbol: 'BBB', pairAddress: 'pair-2' },
      { ...candidate, address: 'token-3', symbol: 'CCC', pairAddress: 'pair-3' },
    ];

    await runPaperCycle({
      candidates,
      paper: { startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 1 },
      minimumScoreToEnter: 75,
      store: {
        saveScoredCandidate: (token) => savedScores.push(token.symbol),
        saveOpenPosition: (position) => savedPositions.push(position.token.symbol),
      },
    });

    // Cap is 1, so only the first opens — but all three are still scored/persisted.
    expect(savedScores).toEqual(['AAA', 'BBB', 'CCC']);
    expect(savedPositions).toEqual(['AAA']);
  });

  it('rehydrates from a broker-state store so the cap holds across runs', async () => {
    const existing: PaperPosition = {
      id: 'paper-1',
      token: { ...candidate, address: 'token-existing', symbol: 'OLD', pairAddress: 'pair-old' },
      score: 80,
      entryPriceUsd: 0.01,
      quantity: 2500,
      openedAt: new Date('2026-01-01T00:00:00Z'),
      highWaterMarkUsd: 0.01,
      lastMarkUsd: 0.01,
    };
    const savedPositions: string[] = [];

    const result = await runPaperCycle({
      candidates: [{ ...candidate, address: 'token-2', symbol: 'NEW', pairAddress: 'pair-2' }],
      paper: { startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 1 },
      minimumScoreToEnter: 75,
      store: {
        saveScoredCandidate: () => {},
        saveOpenPosition: (position: PaperPosition) => savedPositions.push(position.token.symbol),
        // Broker-state reads: one position already open, so the cap of 1 is full.
        loadOpenPositions: () => [existing],
        getRealizedPnlUsd: () => 0,
        getRealizedPnlUsdSince: () => 0,
        getNextPositionSeq: () => 2,
      },
    });

    // The new candidate must not open — the rehydrated broker is already at cap.
    expect(savedPositions).toEqual([]);
    expect(result.broker.getOpenPositions().map((p: PaperPosition) => p.id)).toEqual(['paper-1']);
  });
});
