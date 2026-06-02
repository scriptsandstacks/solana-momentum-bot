// Read-only Solana RPC inspection of a token mint account.
// Checks whether mint authority and freeze authority have been revoked —
// the two most important on-chain signals for fresh-launch rug risk.
//
// Both being null/revoked is a necessary (not sufficient) condition for safety:
//   mintAuthority=null   → creator cannot mint additional supply (no dilution rug)
//   freezeAuthority=null → creator cannot freeze holder token accounts (no freeze rug)
//
// This is a best-effort check: if the RPC call fails or the account is not a
// token mint, the result is 'unknown' for both flags and the caller decides
// whether to penalize or skip.

const SOLANA_PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

export interface MintAuthorityInfo {
  mintAuthorityRevoked: boolean | null;   // null = unknown (RPC error or not a token)
  freezeAuthorityRevoked: boolean | null; // null = unknown
}

interface RpcResponse {
  result?: {
    value?: {
      data?: {
        parsed?: {
          info?: {
            mintAuthority?: string | null;
            freezeAuthority?: string | null;
          };
        };
      } | null;
    } | null;
  };
  error?: { message: string };
}

export async function checkMintAuthority(
  mintAddress: string,
  rpcUrl = SOLANA_PUBLIC_RPC,
  fetchFn: typeof fetch = fetch,
): Promise<MintAuthorityInfo> {
  try {
    const response = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [mintAddress, { encoding: 'jsonParsed' }],
      }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return { mintAuthorityRevoked: null, freezeAuthorityRevoked: null };
    }

    const json = (await response.json()) as RpcResponse;
    const info = json.result?.value?.data?.parsed?.info;

    if (!info) {
      // Not a token mint account, or account doesn't exist.
      return { mintAuthorityRevoked: null, freezeAuthorityRevoked: null };
    }

    return {
      mintAuthorityRevoked: info.mintAuthority === null || info.mintAuthority === undefined,
      freezeAuthorityRevoked: info.freezeAuthority === null || info.freezeAuthority === undefined,
    };
  } catch {
    return { mintAuthorityRevoked: null, freezeAuthorityRevoked: null };
  }
}
