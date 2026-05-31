import { describe, expect, it } from 'vitest';
import { renderReport } from '../src/bot/report.js';
import type { OpportunityScore, TokenCandidate } from '../src/types/domain.js';

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
  routeInputSymbol: 'USDC',
  routeInputMint: 'usdc-mint',
};

const score: OpportunityScore = {
  total: 82,
  recommendation: 'paper_trade',
  reasons: ['route_available'],
  risks: ['low_slippage'],
};

describe('renderReport', () => {
  it('renders candidate and paper account summary', () => {
    const report = renderReport({
      candidates: [{ candidate, score }],
      cashUsd: 975,
      openPositions: 1,
      closedTrades: 0,
    });

    expect(report).toContain('Candidates: 1');
    expect(report).toContain('MOCK');
    expect(report).toContain('score=82');
    expect(report).toContain('Cash: $975.00');
    expect(report).toContain('route=USDC');
    expect(report).toContain('reasons=route_available');
    expect(report).toContain('risks=low_slippage');
  });
});
