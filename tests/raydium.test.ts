import { describe, expect, it } from 'vitest';
import { fetchRaydiumSolanaTokenCandidates, mapRaydiumPoolToCandidate } from '../src/discovery/raydium.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('Raydium pool enrichment', () => {
  it('maps a Raydium pool into a token candidate, prorating volume by pool lifetime', () => {
    // Fixed clock (round seconds) so the 15-minute age is exact and the
    // lifetime-based volume proration is deterministic.
    const now = 1_750_000_000_000;
    const candidate = mapRaydiumPoolToCandidate(
      {
        id: 'ray-pool-1',
        mintA: { address: 'mint-1', symbol: 'PUMP', name: 'Pump Token' },
        mintB: { address: USDC_MINT, symbol: 'USDC', name: 'USD Coin' },
        price: 0.0125,
        tvl: 88_000,
        day: { volume: 24_000 },
        openTime: String(Math.floor((now - 15 * 60 * 1000) / 1000)),
      },
      'mint-1',
      now,
    );

    // Pool is 15m old, so $24k accrued over 15m → $1.6k/min: 5m=$8k, 1h=$96k.
    // A flat /288 would have understated this to ~$83 (5m), failing volume filters.
    expect(candidate).toMatchObject({
      chain: 'solana',
      address: 'mint-1',
      symbol: 'PUMP',
      name: 'Pump Token',
      pairAddress: 'ray-pool-1',
      priceUsd: 0.0125,
      liquidityUsd: 88_000,
      volume5mUsd: 8_000,
      volume1hUsd: 96_000,
      ageMinutes: 15,
      source: 'raydium',
      routeAvailable: false,
    });
  });

  it('converges to the flat 24h split for mature pools (>= 1 day old)', () => {
    const now = 1_750_000_000_000;
    const candidate = mapRaydiumPoolToCandidate(
      {
        id: 'ray-pool-mature',
        mintA: { address: 'mint-1', symbol: 'PUMP', name: 'Pump Token' },
        mintB: { address: USDC_MINT, symbol: 'USDC', name: 'USD Coin' },
        price: 0.0125,
        tvl: 88_000,
        day: { volume: 28_800 },
        openTime: String(Math.floor((now - 5 * 24 * 60 * 60 * 1000) / 1000)),
      },
      'mint-1',
      now,
    );

    // Age capped at 1440m: 28_800/1440 = $20/min → 5m=$100 (== 28_800/288), 1h=$1_200 (== 28_800/24).
    expect(candidate.volume5mUsd).toBeCloseTo(100);
    expect(candidate.volume1hUsd).toBeCloseTo(1_200);
  });

  it('inverts the pool price when the requested mint is mintB and mintA is a stablecoin', () => {
    const candidate = mapRaydiumPoolToCandidate(
      {
        id: 'ray-pool-inverted',
        mintA: { address: USDC_MINT, symbol: 'USDC', name: 'USD Coin' },
        mintB: { address: 'mint-1', symbol: 'PUMP', name: 'Pump Token' },
        price: 80,
        tvl: 88_000,
        day: { volume: 24_000 },
      },
      'mint-1',
    );

    expect(candidate.address).toBe('mint-1');
    expect(candidate.priceUsd).toBeCloseTo(1 / 80, 10);
  });

  it('returns priceUsd 0 for non-stablecoin pools so they are filtered out downstream', async () => {
    const candidate = mapRaydiumPoolToCandidate(
      {
        id: 'ray-pool-sol',
        mintA: { address: 'mint-1', symbol: 'PUMP', name: 'Pump Token' },
        mintB: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'Wrapped SOL' },
        price: 0.0001,
        tvl: 250_000,
        day: { volume: 50_000 },
      },
      'mint-1',
    );

    expect(candidate.priceUsd).toBe(0);

    const candidates = await fetchRaydiumSolanaTokenCandidates(['mint-1'], async () => ({
      success: true,
      data: {
        data: [
          {
            id: 'ray-pool-sol',
            mintA: { address: 'mint-1', symbol: 'PUMP', name: 'Pump Token' },
            mintB: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL', name: 'Wrapped SOL' },
            price: 0.0001,
            tvl: 250_000,
            day: { volume: 50_000 },
          },
        ],
      },
    }));

    expect(candidates).toEqual([]);
  });

  it('drops pools that do not contain the requested mint', async () => {
    const candidates = await fetchRaydiumSolanaTokenCandidates(['mint-1'], async () => ({
      success: true,
      data: {
        data: [
          {
            id: 'unrelated-pool',
            mintA: { address: 'mint-other', symbol: 'X', name: 'X Token' },
            mintB: { address: USDC_MINT, symbol: 'USDC', name: 'USD Coin' },
            price: 1,
            tvl: 100_000,
            day: { volume: 1_000 },
          },
        ],
      },
    }));

    expect(candidates).toEqual([]);
  });

  it('drops pools with zero or missing tvl', async () => {
    const candidates = await fetchRaydiumSolanaTokenCandidates(['mint-1'], async () => ({
      success: true,
      data: {
        data: [
          {
            id: 'empty-pool',
            mintA: { address: 'mint-1', symbol: 'PUMP', name: 'Pump Token' },
            mintB: { address: USDC_MINT, symbol: 'USDC', name: 'USD Coin' },
            price: 0.01,
            tvl: 0,
            day: { volume: 0 },
          },
        ],
      },
    }));

    expect(candidates).toEqual([]);
  });

  it('fetches Raydium mint pools and keeps the deepest-liquidity pool per mint', async () => {
    const urls: string[] = [];
    const candidates = await fetchRaydiumSolanaTokenCandidates(['mint-1', 'mint-1'], async (url) => {
      urls.push(url);
      return {
        success: true,
        data: {
          data: [
            {
              id: 'thin-pool',
              mintA: { address: 'mint-1', symbol: 'PUMP', name: 'Pump Token' },
              mintB: { address: USDC_MINT, symbol: 'USDC', name: 'USD Coin' },
              price: 0.01,
              tvl: 5_000,
              day: { volume: 1_200 },
            },
            {
              id: 'deep-pool',
              mintA: { address: 'mint-1', symbol: 'PUMP', name: 'Pump Token' },
              mintB: { address: USDC_MINT, symbol: 'USDC', name: 'USD Coin' },
              price: 0.011,
              tvl: 55_000,
              day: { volume: 12_000 },
            },
          ],
        },
      };
    });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/pools/info/mint?');
    expect(urls[0]).toContain('mint1=mint-1');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      address: 'mint-1',
      pairAddress: 'deep-pool',
      liquidityUsd: 55_000,
      source: 'raydium',
    });
  });
});
