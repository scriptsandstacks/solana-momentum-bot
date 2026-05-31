import { describe, expect, it } from 'vitest';
import { fetchDexScreenerSolanaTokenCandidates, mapDexScreenerPairToCandidate } from '../src/discovery/dexscreener.js';

describe('DexScreener mapping', () => {
  it('maps a Solana pair into a token candidate', () => {
    const candidate = mapDexScreenerPairToCandidate({
      chainId: 'solana',
      pairAddress: 'pair-abc',
      baseToken: { address: 'token-abc', symbol: 'ABC', name: 'ABC Coin' },
      priceUsd: '0.0123',
      liquidity: { usd: 42_000 },
      volume: { m5: 12_000, h1: 90_000 },
      priceChange: { m5: 15 },
      txns: { m5: { buys: 60, sells: 20 } },
      pairCreatedAt: Date.now() - 10 * 60 * 1000,
    });

    expect(candidate).toMatchObject({
      chain: 'solana',
      address: 'token-abc',
      symbol: 'ABC',
      pairAddress: 'pair-abc',
      liquidityUsd: 42_000,
      volume5mUsd: 12_000,
      buys5m: 60,
      sells5m: 20,
      source: 'dexscreener',
    });
    expect(candidate.ageMinutes).toBeGreaterThanOrEqual(9);
    expect(candidate.ageMinutes).toBeLessThanOrEqual(11);
  });

  it('fetches token-specific Solana candidates and keeps the deepest-liquidity pair per mint', async () => {
    const urls: string[] = [];
    const candidates = await fetchDexScreenerSolanaTokenCandidates(['mint-1', 'mint-1'], async (url) => {
      urls.push(url);
      return {
        pairs: [
          {
            chainId: 'solana',
            pairAddress: 'thin-pair',
            baseToken: { address: 'mint-1', symbol: 'PUMP', name: 'Pump Token' },
            priceUsd: '0.01',
            liquidity: { usd: 5_000 },
            volume: { m5: 500, h1: 1_000 },
            priceChange: { m5: 1 },
            txns: { m5: { buys: 3, sells: 2 } },
          },
          {
            chainId: 'solana',
            pairAddress: 'deep-pair',
            baseToken: { address: 'mint-1', symbol: 'PUMP', name: 'Pump Token' },
            priceUsd: '0.011',
            liquidity: { usd: 50_000 },
            volume: { m5: 7_500, h1: 40_000 },
            priceChange: { m5: 5 },
            txns: { m5: { buys: 20, sells: 10 } },
          },
          {
            chainId: 'base',
            pairAddress: 'wrong-chain',
            baseToken: { address: 'mint-1', symbol: 'PUMP', name: 'Pump Token' },
            priceUsd: '0.01',
          },
        ],
      };
    });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/latest/dex/tokens/mint-1');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      address: 'mint-1',
      pairAddress: 'deep-pair',
      liquidityUsd: 50_000,
      source: 'pumpportal+dexscreener',
    });
  });
});
