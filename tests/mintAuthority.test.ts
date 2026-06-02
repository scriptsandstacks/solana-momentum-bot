import { describe, expect, it } from 'vitest';
import { checkMintAuthority } from '../src/chains/solana/mintAuthority.js';

function rpcResponse(mintAuthority: string | null, freezeAuthority: string | null) {
  return {
    result: {
      value: {
        data: {
          parsed: {
            info: { mintAuthority, freezeAuthority },
          },
        },
      },
    },
  };
}

function fakeFetch(body: object, status = 200): typeof fetch {
  return async () =>
    ({
      ok: status >= 200 && status < 300,
      json: async () => body,
    }) as Response;
}

describe('checkMintAuthority', () => {
  it('returns revoked=true for both when authorities are null (safe token)', async () => {
    const info = await checkMintAuthority('mint1', 'http://rpc', fakeFetch(rpcResponse(null, null)));
    expect(info.mintAuthorityRevoked).toBe(true);
    expect(info.freezeAuthorityRevoked).toBe(true);
  });

  it('returns revoked=false when mint authority is still held', async () => {
    const info = await checkMintAuthority('mint1', 'http://rpc', fakeFetch(rpcResponse('CreatorPubkey', null)));
    expect(info.mintAuthorityRevoked).toBe(false);
    expect(info.freezeAuthorityRevoked).toBe(true);
  });

  it('returns revoked=false when freeze authority is still held', async () => {
    const info = await checkMintAuthority('mint1', 'http://rpc', fakeFetch(rpcResponse(null, 'CreatorPubkey')));
    expect(info.mintAuthorityRevoked).toBe(true);
    expect(info.freezeAuthorityRevoked).toBe(false);
  });

  it('returns unknown (null) on HTTP error', async () => {
    const info = await checkMintAuthority('mint1', 'http://rpc', fakeFetch({}, 500));
    expect(info.mintAuthorityRevoked).toBeNull();
    expect(info.freezeAuthorityRevoked).toBeNull();
  });

  it('returns unknown (null) when account is not a token mint (no parsed data)', async () => {
    const info = await checkMintAuthority('mint1', 'http://rpc', fakeFetch({ result: { value: null } }));
    expect(info.mintAuthorityRevoked).toBeNull();
    expect(info.freezeAuthorityRevoked).toBeNull();
  });

  it('returns unknown (null) on network exception', async () => {
    const boom = async () => { throw new Error('network failure'); };
    const info = await checkMintAuthority('mint1', 'http://rpc', boom as unknown as typeof fetch);
    expect(info.mintAuthorityRevoked).toBeNull();
    expect(info.freezeAuthorityRevoked).toBeNull();
  });
});
