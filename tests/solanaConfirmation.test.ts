import { describe, expect, it, vi } from 'vitest';
import { confirmSolanaTransaction } from '../src/execution/solanaConfirmation.js';

describe('confirmSolanaTransaction', () => {
  it('returns when the transaction is confirmed', async () => {
    const rpcRequest = vi.fn(async (method: string) => {
      if (method === 'getSignatureStatuses') {
        return { value: [{ confirmationStatus: 'confirmed', err: null }] };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    await confirmSolanaTransaction({ signature: 'sig-1', rpcRequest });

    expect(rpcRequest).toHaveBeenCalledTimes(1);
  });

  it('waits for finalized status when finalized commitment is required', async () => {
    let now = 0;
    const rpcRequest = vi.fn(async (method: string) => {
      if (method === 'getSignatureStatuses') {
        return {
          value: [{
            confirmationStatus: rpcRequest.mock.calls.length === 1 ? 'confirmed' : 'finalized',
            err: null,
          }],
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });

    await confirmSolanaTransaction({
      signature: 'sig-finalized',
      commitment: 'finalized',
      rpcRequest,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });

    expect(rpcRequest).toHaveBeenCalledTimes(2);
  });

  it('throws when the transaction failed on-chain', async () => {
    const rpcRequest = vi.fn(async () => ({
      value: [{ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } }],
    }));

    await expect(confirmSolanaTransaction({ signature: 'sig-1', rpcRequest })).rejects.toThrow('failed on-chain');
  });

  it('throws as soon as the last valid block height is exceeded', async () => {
    const rpcRequest = vi.fn(async (method: string) => {
      if (method === 'getSignatureStatuses') return { value: [null] };
      if (method === 'getBlockHeight') return 101;
      throw new Error(`Unexpected method ${method}`);
    });

    await expect(confirmSolanaTransaction({
      signature: 'sig-expired',
      lastValidBlockHeight: 100,
      commitment: 'finalized',
      rpcRequest,
    })).rejects.toThrow('expired at block height 100');
    expect(rpcRequest).toHaveBeenCalledWith('getBlockHeight', [{ commitment: 'finalized' }]);
  });

  it('falls back to timeout when no block-height validity window is available', async () => {
    let now = 0;
    const rpcRequest = vi.fn(async () => ({ value: [null] }));

    await expect(confirmSolanaTransaction({
      signature: 'sig-timeout',
      rpcRequest,
      timeoutMs: 2_000,
      pollIntervalMs: 1_000,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    })).rejects.toThrow('not confirmed within 2 seconds');
  });
});
