// Read-only Solana RPC inspection of SPL token holder concentration.
// A token whose largest holders control most of the supply is a rug risk even
// when momentum/liquidity signals look strong.

const SOLANA_PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

export interface HolderConcentrationInfo {
  top5HolderPct: number | null; // null = unknown (RPC error, no supply, or not a token)
}

interface TokenLargestAccountsResponse {
  result?: {
    value?: Array<{
      amount?: string;
    }>;
  };
}

interface TokenSupplyResponse {
  result?: {
    value?: {
      amount?: string;
    };
  };
}

export async function checkHolderConcentration(
  mintAddress: string,
  rpcUrl = SOLANA_PUBLIC_RPC,
  fetchFn: typeof fetch = fetch,
): Promise<HolderConcentrationInfo> {
  try {
    const response = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenLargestAccounts',
          params: [mintAddress],
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'getTokenSupply',
          params: [mintAddress],
        },
      ]),
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return { top5HolderPct: null };
    }

    const json = (await response.json()) as [TokenLargestAccountsResponse, TokenSupplyResponse];
    const largestAccounts = json.find((entry) => Array.isArray((entry as TokenLargestAccountsResponse).result?.value)) as
      | TokenLargestAccountsResponse
      | undefined;
    const supplyResponse = json.find((entry) => typeof (entry as TokenSupplyResponse).result?.value?.amount === 'string') as
      | TokenSupplyResponse
      | undefined;

    const supply = parseAmount(supplyResponse?.result?.value?.amount);
    if (supply === undefined || supply === 0n) {
      return { top5HolderPct: null };
    }

    const top5 = (largestAccounts?.result?.value ?? [])
      .slice(0, 5)
      .reduce((sum, account) => sum + (parseAmount(account.amount) ?? 0n), 0n);

    return { top5HolderPct: Number((top5 * 10_000n) / supply) / 100 };
  } catch {
    return { top5HolderPct: null };
  }
}

function parseAmount(value: string | undefined): bigint | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  return BigInt(value);
}
