import { describe, expect, it } from 'vitest';
import {
  findMostRecentWalletBuy,
  recoveredBuyEntryPriceUsd,
  SOL_MINT,
  USDC_MINT,
} from '../src/execution/solanaTransactionHistory.js';

const WALLET = 'wallet-pubkey-1111';
const TOKEN_MINT = 'token-mint-abc123';
const RPC_URL = 'https://rpc.example';

function tokenBalance(mint: string, amount: string) {
  return { owner: WALLET, mint, uiTokenAmount: { amount } };
}

function buyTransaction(inputMint = USDC_MINT) {
  return {
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [1_000_000_000],
      postBalances: [999_995_000],
      preTokenBalances: [tokenBalance(inputMint, '25000000')],
      postTokenBalances: [tokenBalance(inputMint, '0'), tokenBalance(TOKEN_MINT, '20000000000')],
    },
    transaction: { message: { accountKeys: [{ pubkey: WALLET }] } },
  };
}

function makeFetchFn(transactions: Record<string, unknown>) {
  return async (_url: string | URL | Request, options?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(options?.body)) as { method: string; params: any[] };
    if (body.method === 'getSignaturesForAddress') {
      return Response.json({
        result: [
          { signature: 'sig-failed', err: { InstructionError: [0, 'Custom'] }, blockTime: 30 },
          { signature: 'sig-unrelated', err: null, blockTime: 20 },
          { signature: 'sig-buy', err: null, blockTime: 10 },
        ],
      });
    }
    if (body.method === 'getTransaction') {
      return Response.json({ result: transactions[body.params[0]] ?? null });
    }
    throw new Error(`Unexpected RPC method ${body.method}`);
  };
}

describe('findMostRecentWalletBuy', () => {
  it('finds the newest successful measurable buy into the orphaned mint', async () => {
    const unrelated = {
      ...buyTransaction(),
      meta: {
        ...buyTransaction().meta,
        postTokenBalances: [tokenBalance(USDC_MINT, '0'), tokenBalance('other-mint', '20000000000')],
      },
    };
    const buy = await findMostRecentWalletBuy({
      walletPublicKey: WALLET,
      outputMint: TOKEN_MINT,
      rpcUrl: RPC_URL,
      fetchFn: makeFetchFn({ 'sig-unrelated': unrelated, 'sig-buy': buyTransaction() }),
    });

    expect(buy).toMatchObject({
      signature: 'sig-buy',
      inputMint: USDC_MINT,
      inputAmount: 25_000_000n,
      outputAmount: 20_000_000_000n,
      networkFeeLamports: 5_000,
      blockTime: 10,
    });
  });

  it('returns undefined when no recent transaction is a measurable buy', async () => {
    const buy = await findMostRecentWalletBuy({
      walletPublicKey: WALLET,
      outputMint: TOKEN_MINT,
      rpcUrl: RPC_URL,
      fetchFn: makeFetchFn({}),
    });

    expect(buy).toBeUndefined();
  });
});

describe('recoveredBuyEntryPriceUsd', () => {
  it('computes exact stablecoin-funded entry price', () => {
    const entry = recoveredBuyEntryPriceUsd({
      signature: 'sig-buy',
      inputMint: USDC_MINT,
      inputAmount: 25_000_000n,
      outputAmount: 20_000_000_000n,
      networkFeeLamports: 5_000,
    }, 6);

    expect(entry).toBeCloseTo(0.00125);
  });

  it('does not invent a USD entry price for SOL-funded buys', () => {
    const entry = recoveredBuyEntryPriceUsd({
      signature: 'sig-buy',
      inputMint: SOL_MINT,
      inputAmount: 125_000_000n,
      outputAmount: 20_000_000_000n,
      networkFeeLamports: 5_000,
    }, 6);

    expect(entry).toBeUndefined();
  });
});
