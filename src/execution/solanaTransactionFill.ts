const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface ConfirmedSwapFill {
  inputAmount: bigint;
  outputAmount: bigint;
  networkFeeLamports: number;
}

interface UiTokenAmount {
  amount?: string;
}

interface TokenBalance {
  mint?: string;
  owner?: string;
  uiTokenAmount?: UiTokenAmount;
}

interface ParsedAccountKey {
  pubkey?: string;
}

export interface ParsedSolanaTransaction {
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction?: {
    message?: {
      accountKeys?: Array<string | ParsedAccountKey>;
    };
  };
}

export function parseConfirmedSwapFill(
  transaction: ParsedSolanaTransaction,
  params: { owner: string; inputMint: string; outputMint: string },
): ConfirmedSwapFill {
  const meta = transaction.meta;
  if (!meta) throw new Error('Confirmed transaction has no metadata');
  if (meta.err) throw new Error(`Confirmed transaction failed on-chain: ${JSON.stringify(meta.err)}`);

  const inputAmount = resolveMintDelta(transaction, params.owner, params.inputMint, 'input');
  const outputAmount = resolveMintDelta(transaction, params.owner, params.outputMint, 'output');

  if (inputAmount <= 0n) {
    throw new Error(`Confirmed transaction has no positive input balance delta for ${params.inputMint}`);
  }
  if (outputAmount <= 0n) {
    throw new Error(`Confirmed transaction has no positive output balance delta for ${params.outputMint}`);
  }

  return {
    inputAmount,
    outputAmount,
    networkFeeLamports: meta.fee ?? 0,
  };
}

function resolveMintDelta(
  transaction: ParsedSolanaTransaction,
  owner: string,
  mint: string,
  direction: 'input' | 'output',
): bigint {
  if (mint === SOL_MINT) {
    return resolveNativeSolDelta(transaction, owner, direction);
  }

  const pre = sumTokenBalances(transaction.meta?.preTokenBalances, owner, mint);
  const post = sumTokenBalances(transaction.meta?.postTokenBalances, owner, mint);
  return direction === 'input' ? pre - post : post - pre;
}

function resolveNativeSolDelta(
  transaction: ParsedSolanaTransaction,
  owner: string,
  direction: 'input' | 'output',
): bigint {
  const keys = transaction.transaction?.message?.accountKeys ?? [];
  const ownerIndex = keys.findIndex((key) => (typeof key === 'string' ? key : key.pubkey) === owner);
  if (ownerIndex < 0) throw new Error(`Confirmed transaction does not include wallet ${owner}`);

  const pre = transaction.meta?.preBalances?.[ownerIndex];
  const post = transaction.meta?.postBalances?.[ownerIndex];
  if (pre === undefined || post === undefined) {
    throw new Error(`Confirmed transaction has no native SOL balances for wallet ${owner}`);
  }

  const fee = transaction.meta?.fee ?? 0;
  if (direction === 'input') {
    return BigInt(Math.max(0, pre - post - fee));
  }
  return BigInt(Math.max(0, post - pre));
}

function sumTokenBalances(balances: TokenBalance[] | undefined, owner: string, mint: string): bigint {
  let total = 0n;
  for (const balance of balances ?? []) {
    if (balance.owner !== owner || balance.mint !== mint) continue;
    const amount = balance.uiTokenAmount?.amount;
    if (amount !== undefined) total += BigInt(amount);
  }
  return total;
}
