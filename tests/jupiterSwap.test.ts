import { describe, expect, it } from 'vitest';
import { getJupiterSwapTransaction, type JupiterQuoteResponse } from '../src/execution/jupiterSwap.js';

const quote: JupiterQuoteResponse = {
  inputMint: 'input-mint',
  inAmount: '1000',
  outputMint: 'output-mint',
  outAmount: '2000',
  slippageBps: 500,
  priceImpactPct: '0.1',
};

describe('getJupiterSwapTransaction', () => {
  it('preserves the transaction validity window returned by Jupiter', async () => {
    const result = await getJupiterSwapTransaction({
      quoteResponse: quote,
      userPublicKey: 'wallet-pubkey',
      baseUrl: 'https://jupiter.example/swap/v1',
      fetchFn: async () => Response.json({
        swapTransaction: 'base64-tx',
        lastValidBlockHeight: 12345,
      }),
    });

    expect(result).toEqual({
      swapTransaction: 'base64-tx',
      lastValidBlockHeight: 12345,
    });
  });
});
