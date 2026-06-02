import { describe, expect, it } from 'vitest';
import { checkHolderConcentration } from '../src/chains/solana/holderConcentration.js';

function rpcResponse(accountAmounts: string[], supply: string) {
  return [
    {
      id: 1,
      result: {
        value: accountAmounts.map((amount) => ({ amount })),
      },
    },
    {
      id: 2,
      result: {
        value: { amount: supply },
      },
    },
  ];
}

function fakeFetch(body: object, status = 200): typeof fetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      json: async () => body,
    }) as Response;
}

describe('checkHolderConcentration', () => {
  it('returns the top five holder percentage from raw token amounts', async () => {
    const info = await checkHolderConcentration(
      'mint1',
      'http://rpc',
      fakeFetch(rpcResponse(['300', '200', '150', '100', '50', '300'], '1000')),
    );

    expect(info.top5HolderPct).toBe(80);
  });

  it('returns unknown on HTTP error', async () => {
    const info = await checkHolderConcentration('mint1', 'http://rpc', fakeFetch({}, 500));
    expect(info.top5HolderPct).toBeNull();
  });

  it('returns unknown when supply is zero or missing', async () => {
    const info = await checkHolderConcentration('mint1', 'http://rpc', fakeFetch(rpcResponse(['100'], '0')));
    expect(info.top5HolderPct).toBeNull();
  });

  it('returns unknown on network exception', async () => {
    const boom = async () => { throw new Error('network failure'); };
    const info = await checkHolderConcentration('mint1', 'http://rpc', boom as unknown as typeof fetch);
    expect(info.top5HolderPct).toBeNull();
  });
});
