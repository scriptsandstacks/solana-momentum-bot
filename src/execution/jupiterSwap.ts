// Jupiter Swap API — full quote + swap-transaction flow for execution.
// The quote endpoint is shared with discovery; this module adds the swap
// transaction step needed before submission to the chain.

const KEYED_BASE = 'https://api.jup.ag/swap/v1';
const KEYLESS_BASE = 'https://lite-api.jup.ag/swap/v1';

// The full quote response object returned by Jupiter. Passed verbatim to the
// swap endpoint so every field Jupiter needs for transaction construction is
// preserved — we treat it as an opaque bag plus the fields we read ourselves.
export type JupiterQuoteResponse = Record<string, unknown> & {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  slippageBps: number;
  priceImpactPct: string;
};

export interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippageBps: number;
  swapMode?: 'ExactIn' | 'ExactOut';
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface JupiterSwapTransactionParams {
  quoteResponse: JupiterQuoteResponse;
  userPublicKey: string;
  wrapAndUnwrapSol?: boolean;
  // 'auto' lets Jupiter set the priority fee; a number is lamports.
  prioritizationFeeLamports?: number | 'auto';
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

function resolveBase(apiKey?: string, baseUrl?: string): { base: string; apiKey: string | undefined } {
  const key = apiKey ?? process.env.JUPITER_API_KEY;
  // JUPITER_QUOTE_URL may point at the old quote-only host; strip the path
  // component and fall back to the swap API base so both env vars work.
  const envBase = process.env.JUPITER_QUOTE_URL?.replace(/\/quote.*/, '');
  const base = baseUrl ?? envBase ?? (key ? KEYED_BASE : KEYLESS_BASE);
  return { base, apiKey: key };
}

function swapHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return headers;
}

// Get a full Jupiter quote suitable for passing to getJupiterSwapTransaction.
// Returns undefined when no route exists or the API is unreachable.
export async function getJupiterQuoteForSwap(params: JupiterQuoteParams): Promise<JupiterQuoteResponse | undefined> {
  const { base, apiKey } = resolveBase(params.apiKey, params.baseUrl);
  const query = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: String(params.amount),
    slippageBps: String(params.slippageBps),
    ...(params.swapMode ? { swapMode: params.swapMode } : {}),
  });

  try {
    const fetchFn = params.fetchFn ?? fetch;
    const res = await fetchFn(`${base}/quote?${query}`, { headers: swapHeaders(apiKey) });
    if (!res.ok) return undefined;
    const json = (await res.json()) as Record<string, unknown>;
    if (!json?.outAmount) return undefined;
    return json as JupiterQuoteResponse;
  } catch {
    return undefined;
  }
}

// Build a swap transaction from a quote. Returns the base64-encoded serialized
// transaction that the caller signs and sends via the RPC.
// Returns undefined if the swap endpoint is unreachable or rejects the request.
export async function getJupiterSwapTransaction(params: JupiterSwapTransactionParams): Promise<string | undefined> {
  const { base, apiKey } = resolveBase(params.apiKey, params.baseUrl);
  const headers = { ...swapHeaders(apiKey), 'content-type': 'application/json' };

  const body: Record<string, unknown> = {
    quoteResponse: params.quoteResponse,
    userPublicKey: params.userPublicKey,
    wrapAndUnwrapSol: params.wrapAndUnwrapSol ?? true,
    dynamicComputeUnitLimit: true,
  };
  if (params.prioritizationFeeLamports !== undefined) {
    body.prioritizationFeeLamports = params.prioritizationFeeLamports;
  }

  try {
    const fetchFn = params.fetchFn ?? fetch;
    const res = await fetchFn(`${base}/swap`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { swapTransaction?: string };
    return json?.swapTransaction;
  } catch {
    return undefined;
  }
}
