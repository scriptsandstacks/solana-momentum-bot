import { describe, expect, it } from 'vitest';
import { fetchPumpPortalMarketCandidates } from '../src/bot/pumpCandidates.js';
import type { TokenCandidate } from '../src/types/domain.js';

function candidate(address: string, source: string, liquidityUsd: number): TokenCandidate {
  return {
    chain: 'solana',
    address,
    symbol: 'PUMP',
    name: 'Pump Token',
    pairAddress: `${source}-pair`,
    priceUsd: 0.01,
    liquidityUsd,
    volume5mUsd: 10_000,
    volume1hUsd: 50_000,
    priceChange5mPct: 5,
    buys5m: 20,
    sells5m: 10,
    ageMinutes: 10,
    source,
    routeAvailable: false,
    estimatedSlippageBps: 10_000,
  };
}

describe('PumpPortal market candidate enrichment', () => {
  it('combines DexScreener and Raydium candidates and keeps the deepest liquidity per mint', async () => {
    const candidates = await fetchPumpPortalMarketCandidates(
      ['mint-1', 'mint-2'],
      async () => [candidate('mint-1', 'pumpportal+dexscreener', 40_000)],
      async () => [candidate('mint-1', 'raydium', 90_000), candidate('mint-2', 'raydium', 30_000)],
    );

    expect(candidates).toHaveLength(2);
    expect(candidates.map((item) => item.address)).toEqual(['mint-1', 'mint-2']);
    expect(candidates[0]).toMatchObject({
      address: 'mint-1',
      liquidityUsd: 90_000,
      source: 'pumpportal+dexscreener+raydium',
    });
    expect(candidates[1]).toMatchObject({ address: 'mint-2', source: 'raydium' });
  });
});
