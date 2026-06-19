import { describe, expect, it } from 'vitest';
import { fetchPumpPortalMarketCandidates } from '../src/bot/pumpCandidates.js';
import type { TokenCandidate } from '../src/types/domain.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

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

  it('keeps DexScreener activity even when a deeper Raydium pool wins on liquidity', async () => {
    // Raydium is deeper but reports zeroed/synthetic activity; DexScreener is
    // shallower but carries the real 5m volume, buy/sell counts, and momentum.
    const dex: TokenCandidate = {
      ...candidate('mint-1', 'pumpportal+dexscreener', 30_000),
      volume5mUsd: 18_000,
      volume1hUsd: 120_000,
      priceChange5mPct: 12,
      buys5m: 90,
      sells5m: 25,
    };
    const raydium: TokenCandidate = {
      ...candidate('mint-1', 'raydium', 95_000),
      volume5mUsd: 200,
      volume1hUsd: 2_400,
      priceChange5mPct: 0,
      buys5m: 0,
      sells5m: 0,
    };

    const [merged] = await fetchPumpPortalMarketCandidates(
      ['mint-1'],
      async () => [dex],
      async () => [raydium],
    );

    // Liquidity/pair from the deeper Raydium pool...
    expect(merged.liquidityUsd).toBe(95_000);
    expect(merged.pairAddress).toBe('raydium-pair');
    // ...but the live activity signal from DexScreener, not Raydium's blanks.
    expect(merged.volume5mUsd).toBe(18_000);
    expect(merged.volume1hUsd).toBe(120_000);
    expect(merged.priceChange5mPct).toBe(12);
    expect(merged.buys5m).toBe(90);
    expect(merged.sells5m).toBe(25);
    expect(merged.source).toBe('pumpportal+dexscreener+raydium');
  });

  it('does not fetch or return route input mints as trade candidates', async () => {
    const seenDexMints: string[][] = [];
    const seenRaydiumMints: string[][] = [];
    const candidates = await fetchPumpPortalMarketCandidates(
      ['mint-1', USDC_MINT],
      async (mints) => {
        seenDexMints.push(mints);
        return [candidate('mint-1', 'pumpportal+dexscreener', 40_000), candidate(USDC_MINT, 'pumpportal+dexscreener', 4_000_000)];
      },
      async (mints) => {
        seenRaydiumMints.push(mints);
        return [];
      },
    );

    expect(seenDexMints).toEqual([['mint-1']]);
    expect(seenRaydiumMints).toEqual([['mint-1']]);
    expect(candidates.map((item) => item.address)).toEqual(['mint-1']);
  });
});
