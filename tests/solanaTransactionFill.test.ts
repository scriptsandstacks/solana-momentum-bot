import { describe, expect, it } from 'vitest';
import { parseConfirmedSwapFill, type ParsedSolanaTransaction } from '../src/execution/solanaTransactionFill.js';

const OWNER = 'wallet-pubkey-1111';
const TOKEN_MINT = 'token-mint-abc123';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

function tokenBalance(mint: string, amount: string) {
  return { owner: OWNER, mint, uiTokenAmount: { amount } };
}

function transaction(overrides: Partial<ParsedSolanaTransaction> = {}): ParsedSolanaTransaction {
  return {
    meta: {
      err: null,
      fee: 5_000,
      preBalances: [1_000_000_000],
      postBalances: [999_995_000],
      preTokenBalances: [],
      postTokenBalances: [],
    },
    transaction: {
      message: {
        accountKeys: [{ pubkey: OWNER }],
      },
    },
    ...overrides,
  };
}

describe('parseConfirmedSwapFill', () => {
  it('reads token input and output deltas for a wallet', () => {
    const tx = transaction({
      meta: {
        err: null,
        fee: 5_000,
        preTokenBalances: [tokenBalance(USDC_MINT, '25000000')],
        postTokenBalances: [tokenBalance(USDC_MINT, '0'), tokenBalance(TOKEN_MINT, '20000000000')],
      },
    });

    expect(parseConfirmedSwapFill(tx, {
      owner: OWNER,
      inputMint: USDC_MINT,
      outputMint: TOKEN_MINT,
    })).toEqual({
      inputAmount: 25_000_000n,
      outputAmount: 20_000_000_000n,
      networkFeeLamports: 5_000,
    });
  });

  it('sums multiple token accounts owned by the wallet', () => {
    const tx = transaction({
      meta: {
        err: null,
        fee: 5_000,
        preTokenBalances: [tokenBalance(TOKEN_MINT, '100'), tokenBalance(TOKEN_MINT, '200')],
        postTokenBalances: [tokenBalance(TOKEN_MINT, '0'), tokenBalance(USDC_MINT, '25000000')],
      },
    });

    const fill = parseConfirmedSwapFill(tx, {
      owner: OWNER,
      inputMint: TOKEN_MINT,
      outputMint: USDC_MINT,
    });

    expect(fill.inputAmount).toBe(300n);
    expect(fill.outputAmount).toBe(25_000_000n);
  });

  it('reads native SOL input from wallet balances and excludes the network fee', () => {
    const tx = transaction({
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [1_000_000_000],
        postBalances: [874_995_000],
        preTokenBalances: [],
        postTokenBalances: [tokenBalance(TOKEN_MINT, '25000000000')],
      },
    });

    const fill = parseConfirmedSwapFill(tx, {
      owner: OWNER,
      inputMint: SOL_MINT,
      outputMint: TOKEN_MINT,
    });

    expect(fill.inputAmount).toBe(125_000_000n);
    expect(fill.outputAmount).toBe(25_000_000_000n);
  });

  it('rejects a transaction without an output balance delta', () => {
    const tx = transaction({
      meta: {
        err: null,
        fee: 5_000,
        preTokenBalances: [tokenBalance(USDC_MINT, '25000000')],
        postTokenBalances: [tokenBalance(USDC_MINT, '0')],
      },
    });

    expect(() => parseConfirmedSwapFill(tx, {
      owner: OWNER,
      inputMint: USDC_MINT,
      outputMint: TOKEN_MINT,
    })).toThrow('no positive output balance delta');
  });

  it('rejects an on-chain failed transaction', () => {
    const tx = transaction({
      meta: {
        err: { InstructionError: [1, 'Custom'] },
        fee: 5_000,
      },
    });

    expect(() => parseConfirmedSwapFill(tx, {
      owner: OWNER,
      inputMint: USDC_MINT,
      outputMint: TOKEN_MINT,
    })).toThrow('failed on-chain');
  });
});
