import { describe, expect, it } from 'vitest';
import { checkJupiterRoute } from '../src/discovery/jupiter.js';

describe('Jupiter route check', () => {
  it('returns route availability and slippage estimate from a quote response', async () => {
    const quote = await checkJupiterRoute('token-abc', {
      fetchJson: async () => ({
        outAmount: '950000',
        otherAmountThreshold: '940500',
        priceImpactPct: '0.012',
      }),
    });

    expect(quote.routeAvailable).toBe(true);
    expect(quote.estimatedSlippageBps).toBe(120);
    expect(quote.routeInputSymbol).toBe('SOL');
  });

  it('tries SOL, USDC, and USDT and returns the best available route', async () => {
    const seenInputMints: string[] = [];
    const quote = await checkJupiterRoute('token-abc', {
      fetchJson: async (url) => {
        const parsed = new URL(url);
        const inputMint = parsed.searchParams.get('inputMint') ?? '';
        seenInputMints.push(inputMint);
        if (seenInputMints.length === 1) {
          throw new Error('SOL route unavailable');
        }
        if (seenInputMints.length === 2) {
          return { outAmount: '1000', priceImpactPct: '0.02' };
        }
        return { outAmount: '1000', priceImpactPct: '0.005' };
      },
    });

    expect(seenInputMints).toHaveLength(3);
    expect(quote.routeAvailable).toBe(true);
    expect(quote.routeInputSymbol).toBe('USDT');
    expect(quote.estimatedSlippageBps).toBe(50);
  });

  it('queries the migrated api.jup.ag Swap API with the canonical USDT mint', async () => {
    const seenUrls: string[] = [];
    await checkJupiterRoute('token-abc', {
      fetchJson: async (url) => {
        seenUrls.push(url);
        return { outAmount: '1000', priceImpactPct: '0.01' };
      },
    });

    expect(seenUrls).toHaveLength(3);
    expect(seenUrls.every((url) => url.startsWith('https://api.jup.ag/swap/v1/quote?'))).toBe(true);
    // The deprecated quote-api.jup.ag/v6 host must no longer be used.
    expect(seenUrls.some((url) => url.includes('quote-api.jup.ag'))).toBe(false);
    // Canonical Solana USDT mint, not the previous mistyped value.
    const usdtUrl = seenUrls.find((url) => new URL(url).searchParams.get('inputMint') === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY2Sr6MGt9RktwD');
    expect(usdtUrl).toBeDefined();
  });

  it('returns unavailable route when every quote fetch fails', async () => {
    const quote = await checkJupiterRoute('token-abc', {
      fetchJson: async () => {
        throw new Error('no route');
      },
    });

    expect(quote.routeAvailable).toBe(false);
    expect(quote.estimatedSlippageBps).toBe(10_000);
    expect(quote.routeInputSymbol).toBeUndefined();
  });
});
