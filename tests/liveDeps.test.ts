import { describe, expect, it } from 'vitest';
import { queryWalletCashInventory, queryWalletCashUsd } from '../src/execution/liveDeps.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY2Sr6MGt9RktwD';

describe('queryWalletCashUsd', () => {
  it('values SOL, USDC, and USDT route-input inventory', async () => {
    const rpcRequest = async (method: string, params: unknown[]) => {
      if (method === 'getBalance') return { value: 2_000_000_000 };
      const mint = (params[1] as { mint: string }).mint;
      const amount = mint === USDC_MINT ? '125000000' : mint === USDT_MINT ? '50000000' : '0';
      return {
        value: [{
          account: {
            data: {
              parsed: { info: { tokenAmount: { amount } } },
            },
          },
        }],
      };
    };

    const cashUsd = await queryWalletCashUsd(
      'wallet-public-key',
      { getSolPriceUsd: async () => 150 },
      rpcRequest,
    );

    expect(cashUsd).toBe(475);
  });

  it('sums multiple token accounts for the same stablecoin mint', async () => {
    const rpcRequest = async (method: string, params: unknown[]) => {
      if (method === 'getBalance') return { value: 0 };
      const mint = (params[1] as { mint: string }).mint;
      if (mint !== USDC_MINT) return { value: [] };
      return {
        value: [
          { account: { data: { parsed: { info: { tokenAmount: { amount: '1000000' } } } } } },
          { account: { data: { parsed: { info: { tokenAmount: { amount: '2500000' } } } } } },
        ],
      };
    };

    const cashUsd = await queryWalletCashUsd(
      'wallet-public-key',
      { getSolPriceUsd: async () => 150 },
      rpcRequest,
    );

    expect(cashUsd).toBe(3.5);
  });

  it('returns structured wallet route-input inventory', async () => {
    const rpcRequest = async (method: string, params: unknown[]) => {
      if (method === 'getBalance') return { value: 7_500_000 };
      const mint = (params[1] as { mint: string }).mint;
      const amount = mint === USDC_MINT ? '42000000' : mint === USDT_MINT ? '1500000' : '0';
      return {
        value: [{
          account: {
            data: {
              parsed: { info: { tokenAmount: { amount } } },
            },
          },
        }],
      };
    };

    const inventory = await queryWalletCashInventory(
      'wallet-public-key',
      { getSolPriceUsd: async () => 200 },
      rpcRequest,
    );

    expect(inventory).toMatchObject({
      publicKey: 'wallet-public-key',
      solLamports: 7_500_000n,
      sol: 0.0075,
      solUsd: 1.5,
      solPriceUsd: 200,
      usdc: 42,
      usdt: 1.5,
      totalUsd: 45,
    });
  });
});
