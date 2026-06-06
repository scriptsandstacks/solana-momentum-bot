import { parseConfirmedSwapFill, type ParsedSolanaTransaction } from './solanaTransactionFill.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY2Sr6MGt9RktwD';

const SUPPORTED_INPUT_MINTS = [USDC_MINT, USDT_MINT, SOL_MINT] as const;

export interface RecoveredWalletBuy {
  signature: string;
  inputMint: string;
  inputAmount: bigint;
  outputAmount: bigint;
  networkFeeLamports: number;
  blockTime?: number;
}

export interface FindWalletBuyOptions {
  walletPublicKey: string;
  outputMint: string;
  rpcUrl: string;
  limit?: number;
  fetchFn?: typeof fetch;
}

export async function findMostRecentWalletBuy(
  options: FindWalletBuyOptions,
): Promise<RecoveredWalletBuy | undefined> {
  const fetchFn = options.fetchFn ?? fetch;
  const signatures = await rpcRequest<Array<{ signature?: string; err?: unknown; blockTime?: number | null }>>(
    options.rpcUrl,
    'getSignaturesForAddress',
    [options.walletPublicKey, { limit: options.limit ?? 50 }],
    fetchFn,
  );

  for (const row of signatures ?? []) {
    if (!row.signature || row.err) continue;
    const transaction = await rpcRequest<ParsedSolanaTransaction | null>(
      options.rpcUrl,
      'getTransaction',
      [
        row.signature,
        {
          commitment: 'confirmed',
          encoding: 'jsonParsed',
          maxSupportedTransactionVersion: 0,
        },
      ],
      fetchFn,
    );
    if (!transaction) continue;

    for (const inputMint of SUPPORTED_INPUT_MINTS) {
      try {
        const fill = parseConfirmedSwapFill(transaction, {
          owner: options.walletPublicKey,
          inputMint,
          outputMint: options.outputMint,
        });
        return {
          signature: row.signature,
          inputMint,
          ...fill,
          blockTime: row.blockTime ?? undefined,
        };
      } catch {
        // This transaction was not a measurable buy from this input mint.
      }
    }
  }

  return undefined;
}

export function recoveredBuyEntryPriceUsd(
  buy: RecoveredWalletBuy,
  outputDecimals: number,
  solPriceUsd?: number,
): number | undefined {
  const outputQuantity = Number(buy.outputAmount) / Math.pow(10, outputDecimals);
  if (!Number.isFinite(outputQuantity) || outputQuantity <= 0) return undefined;

  if (buy.inputMint === USDC_MINT || buy.inputMint === USDT_MINT) {
    const inputUsd = Number(buy.inputAmount) / 1e6;
    return inputUsd / outputQuantity;
  }
  if (buy.inputMint === SOL_MINT && solPriceUsd !== undefined && Number.isFinite(solPriceUsd) && solPriceUsd > 0) {
    const inputUsd = (Number(buy.inputAmount) / 1e9) * solPriceUsd;
    return inputUsd / outputQuantity;
  }
  return undefined;
}

async function rpcRequest<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  fetchFn: typeof fetch,
): Promise<T> {
  const response = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Solana RPC ${method} failed: ${response.status} ${response.statusText}`);
  const json = await response.json() as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`Solana RPC ${method}: ${json.error.message}`);
  return json.result as T;
}
