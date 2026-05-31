import { describe, expect, it } from 'vitest';
import { runPaperCycle } from '../src/bot/paperCycle.js';
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

describe('runPaperCycle', () => {
  it('scores candidates, persists them, and opens qualifying paper positions', () => {
    const savedScores: string[] = [];
    const savedPositions: string[] = [];

    const result = runPaperCycle({
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
});
