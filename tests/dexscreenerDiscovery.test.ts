import { describe, expect, it } from 'vitest';
import { fetchDexScreenerSolanaPairs } from '../src/discovery/dexscreener.js';

describe('DexScreener multi-query discovery', () => {
  it('fetches multiple Solana searches, dedupes pairs, and sorts by liquidity', async () => {
    const urls: string[] = [];
    const candidates = await fetchDexScreenerSolanaPairs(async (url) => {
      urls.push(url);
      if (url.includes('q=SOL')) {
        return {
          pairs: [
            {
              chainId: 'solana',
              pairAddress: 'pair-low',
              baseToken: { address: 'token-low', symbol: 'LOW', name: 'Low' },
              priceUsd: '0.01',
              liquidity: { usd: 10_000 },
              volume: { m5: 6_000, h1: 30_000 },
              txns: { m5: { buys: 10, sells: 5 } },
            },
          ],
        };
      }
      return {
        pairs: [
          {
            chainId: 'solana',
            pairAddress: 'pair-high',
            baseToken: { address: 'token-high', symbol: 'HIGH', name: 'High' },
            priceUsd: '0.02',
            liquidity: { usd: 80_000 },
            volume: { m5: 20_000, h1: 100_000 },
            txns: { m5: { buys: 50, sells: 20 } },
          },
          {
            chainId: 'solana',
            pairAddress: 'pair-low',
            baseToken: { address: 'token-low', symbol: 'LOW', name: 'Low' },
            priceUsd: '0.01',
            liquidity: { usd: 10_000 },
            volume: { m5: 6_000, h1: 30_000 },
            txns: { m5: { buys: 10, sells: 5 } },
          },
        ],
      };
    });

    expect(urls.length).toBeGreaterThan(1);
    expect(candidates.map((candidate) => candidate.pairAddress)).toEqual(['pair-high', 'pair-low']);
  });
});
