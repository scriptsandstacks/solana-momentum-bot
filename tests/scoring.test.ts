import { describe, expect, it } from 'vitest';
import { scoreTokenCandidate } from '../src/scoring/scoreToken.js';
import type { TokenCandidate } from '../src/types/domain.js';

const baseCandidate: TokenCandidate = {
  chain: 'solana',
  address: 'So11111111111111111111111111111111111111112',
  symbol: 'TEST',
  name: 'Test Token',
  pairAddress: 'pair-1',
  priceUsd: 0.001,
  liquidityUsd: 25_000,
  volume5mUsd: 20_000,
  volume1hUsd: 100_000,
  priceChange5mPct: 12,
  buys5m: 125,
  sells5m: 55,
  ageMinutes: 20,
  source: 'test',
  routeAvailable: true,
  estimatedSlippageBps: 120,
};

describe('scoreTokenCandidate', () => {
  it('scores a strong liquid routed candidate high enough for paper entry', () => {
    const score = scoreTokenCandidate(baseCandidate);

    expect(score.total).toBeGreaterThanOrEqual(75);
    expect(score.recommendation).toBe('paper_trade');
    expect(score.reasons).toContain('liquidity_ok');
    expect(score.reasons).toContain('route_available');
  });

  it('penalizes candidates without a route', () => {
    const score = scoreTokenCandidate({ ...baseCandidate, routeAvailable: false });

    expect(score.total).toBeLessThan(75);
    expect(score.recommendation).not.toBe('paper_trade');
    expect(score.risks).toContain('no_route');
  });

  it('rejects candidates with tiny liquidity', () => {
    const score = scoreTokenCandidate({ ...baseCandidate, liquidityUsd: 1_000 });

    expect(score.total).toBeLessThan(65);
    expect(score.risks).toContain('low_liquidity');
  });
});
