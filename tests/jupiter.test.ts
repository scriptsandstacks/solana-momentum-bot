import { describe, expect, it } from 'vitest';
import { checkJupiterRoute, quoteJupiterSellImpactBps } from '../src/discovery/jupiter.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('Jupiter route check', () => {
  it('returns route availability, slippage, and sell-route status from quote responses', async () => {
    const quote = await checkJupiterRoute('token-abc', {
      fetchJson: async () => ({
        outAmount: '950000',
        inAmount: '1000000',
        otherAmountThreshold: '940500',
        priceImpactPct: '0.012',
      }),
    });

    expect(quote.routeAvailable).toBe(true);
    expect(quote.estimatedSlippageBps).toBe(120);
    expect(quote.routeInputSymbol).toBe('SOL');
    expect(quote.sellRouteAvailable).toBe(true);
  });

  it('reports sell route as unavailable when the sell probe returns no inAmount', async () => {
    const quote = await checkJupiterRoute('token-abc', {
      fetchJson: async (url) => {
        const mode = new URL(url).searchParams.get('swapMode');
        if (mode === 'ExactOut') return {}; // sell probe fails: no inAmount
        return { outAmount: '950000', priceImpactPct: '0.012' };
      },
    });

    expect(quote.routeAvailable).toBe(true);
    expect(quote.sellRouteAvailable).toBe(false);
  });

  it('tries SOL, USDC, and USDT and returns the best available buy route', async () => {
    const seenBuyInputMints: string[] = [];
    const quote = await checkJupiterRoute('token-abc', {
      fetchJson: async (url) => {
        const parsed = new URL(url);
        if (parsed.searchParams.get('swapMode') === 'ExactOut') {
          return { inAmount: '1000', priceImpactPct: '0.01' }; // sell probe
        }
        const inputMint = parsed.searchParams.get('inputMint') ?? '';
        seenBuyInputMints.push(inputMint);
        if (seenBuyInputMints.length === 1) throw new Error('SOL route unavailable');
        if (seenBuyInputMints.length === 2) return { outAmount: '1000', priceImpactPct: '0.02' };
        return { outAmount: '1000', priceImpactPct: '0.005' };
      },
    });

    expect(seenBuyInputMints).toHaveLength(3);
    expect(quote.routeAvailable).toBe(true);
    expect(quote.routeInputSymbol).toBe('USDT');
    expect(quote.estimatedSlippageBps).toBe(50);
    expect(quote.sellRouteAvailable).toBe(true);
  });

  it('defaults to the keyless lite-api host and never uses the deprecated v6 host', async () => {
    const savedKey = process.env.JUPITER_API_KEY;
    delete process.env.JUPITER_API_KEY;
    const seenUrls: string[] = [];
    try {
      await checkJupiterRoute('token-abc', {
        fetchJson: async (url) => {
          seenUrls.push(url);
          // Return valid responses for both buy (outAmount) and sell probe (inAmount).
          return { outAmount: '1000', inAmount: '1000', priceImpactPct: '0.01' };
        },
      });
    } finally {
      if (savedKey !== undefined) process.env.JUPITER_API_KEY = savedKey;
    }

    // 3 buy probes (SOL/USDC/USDT) + 1 sell probe = 4 total.
    expect(seenUrls).toHaveLength(4);
    expect(seenUrls.every((url) => url.startsWith('https://lite-api.jup.ag/swap/v1/quote?'))).toBe(true);
    // The deprecated quote-api.jup.ag/v6 host must no longer be used.
    expect(seenUrls.some((url) => url.includes('quote-api.jup.ag'))).toBe(false);
    // Canonical Solana USDT mint, not the previous mistyped value.
    const usdtUrl = seenUrls.find((url) => new URL(url).searchParams.get('inputMint') === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY2Sr6MGt9RktwD');
    expect(usdtUrl).toBeDefined();
  });

  it('upgrades to the keyed api.jup.ag host when an API key is provided', async () => {
    const seenUrls: string[] = [];
    await checkJupiterRoute('token-abc', {
      apiKey: 'test-key',
      fetchJson: async (url) => {
        seenUrls.push(url);
        return { outAmount: '1000', inAmount: '1000', priceImpactPct: '0.01' };
      },
    });

    expect(seenUrls.every((url) => url.startsWith('https://api.jup.ag/swap/v1/quote?'))).toBe(true);
  });

  it('returns unavailable buy and sell routes when every quote fetch fails', async () => {
    const quote = await checkJupiterRoute('token-abc', {
      fetchJson: async () => {
        throw new Error('no route');
      },
    });

    expect(quote.routeAvailable).toBe(false);
    expect(quote.estimatedSlippageBps).toBe(10_000);
    expect(quote.routeInputSymbol).toBeUndefined();
    expect(quote.sellRouteAvailable).toBe(false);
  });
});

describe('quoteJupiterSellImpactBps', () => {
  it('quotes an ExactOut sell into USDC sized in 6-decimal base units', async () => {
    let seenUrl = '';
    const bps = await quoteJupiterSellImpactBps('token-abc', 250, {
      fetchJson: async (url) => {
        seenUrl = url;
        return { inAmount: '1000000', priceImpactPct: '0.0275' };
      },
    });

    const params = new URL(seenUrl).searchParams;
    expect(params.get('inputMint')).toBe('token-abc');
    expect(params.get('outputMint')).toBe(USDC_MINT);
    expect(params.get('swapMode')).toBe('ExactOut');
    // $250 of USDC at 6 decimals.
    expect(params.get('amount')).toBe('250000000');
    expect(bps).toBe(275);
  });

  it('returns undefined when no route/quote is available', async () => {
    expect(
      await quoteJupiterSellImpactBps('token-abc', 250, {
        fetchJson: async () => {
          throw new Error('no route');
        },
      }),
    ).toBeUndefined();
    // Non-positive size never quotes.
    expect(await quoteJupiterSellImpactBps('token-abc', 0)).toBeUndefined();
  });
});
