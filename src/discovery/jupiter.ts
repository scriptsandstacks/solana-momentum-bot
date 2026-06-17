interface JupiterDeps {
  fetchJson?: (url: string) => Promise<any>;
  // Free-tier key from https://portal.jup.ag, sent as the x-api-key header.
  // Defaults to the JUPITER_API_KEY env var.
  apiKey?: string;
  // Override the quote endpoint host (e.g. the keyless lite-api.jup.ag during
  // the migration grace period). Defaults to JUPITER_QUOTE_URL then DEFAULT_QUOTE_URL.
  baseUrl?: string;
}

export interface JupiterRouteCheck {
  routeAvailable: boolean;
  estimatedSlippageBps: number;
  routeInputMint?: string;
  routeInputSymbol?: string;
  // Whether a token→USDC sell route exists. false = honeypot signal.
  // undefined only if the sell probe was skipped (should not happen via checkJupiterRoute).
  sellRouteAvailable: boolean;
}

// Quote API V6 (`quote-api.jup.ag/v6`) was deprecated on 2025-10-01. The forward
// path is the Swap API; the query params are unchanged, only the host moved.
//   - api.jup.ag      requires a free API key (x-api-key from https://portal.jup.ag)
//   - lite-api.jup.ag is keyless (deprecation postponed indefinitely as of 2026)
// We pick the host from whether a key is present, so the bot runs keyless out of
// the box and automatically upgrades to the keyed host once JUPITER_API_KEY is
// set. JUPITER_QUOTE_URL overrides the host explicitly.
const KEYED_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';
const KEYLESS_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;

const ROUTE_INPUTS = [
  {
    symbol: 'SOL',
    mint: 'So11111111111111111111111111111111111111112',
    amount: 10_000_000,
  },
  {
    symbol: 'USDC',
    mint: USDC_MINT,
    amount: 10_000_000,
  },
  {
    symbol: 'USDT',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY2Sr6MGt9RktwD',
    amount: 10_000_000,
  },
];

function resolveQuoteEndpoint(deps: JupiterDeps): { baseUrl: string; fetchJson: (url: string) => Promise<any> } {
  const apiKey = deps.apiKey ?? process.env.JUPITER_API_KEY;
  const baseUrl = deps.baseUrl ?? process.env.JUPITER_QUOTE_URL ?? (apiKey ? KEYED_QUOTE_URL : KEYLESS_QUOTE_URL);
  const fetchJson = deps.fetchJson ?? ((url: string) => defaultFetchJson(url, apiKey));
  return { baseUrl, fetchJson };
}

// Estimate the price impact (bps) of selling a position out to USDC, sized to
// the position's USD value. Uses an ExactOut quote (token -> exactly this much
// USDC) so we never need the token's decimals — only USDC's, which are fixed.
// Best-effort: returns undefined when no route/quote is available so callers
// can fall back to a coarser estimate. This is the realistic exit-leg slippage,
// freshly quoted in the sell direction at the actual size — unlike the entry
// route check, which probes a small fixed buy.
export async function quoteJupiterSellImpactBps(
  tokenMint: string,
  usdcOutUsd: number,
  deps: JupiterDeps = {},
): Promise<number | undefined> {
  if (!tokenMint || !Number.isFinite(usdcOutUsd) || usdcOutUsd <= 0) return undefined;
  const usdcOutBaseUnits = Math.round(usdcOutUsd * 10 ** USDC_DECIMALS);
  if (usdcOutBaseUnits <= 0) return undefined;

  const { baseUrl, fetchJson } = resolveQuoteEndpoint(deps);
  const params = new URLSearchParams({
    inputMint: tokenMint,
    outputMint: USDC_MINT,
    amount: String(usdcOutBaseUnits),
    swapMode: 'ExactOut',
    slippageBps: '500',
  });

  try {
    const quote = await fetchJson(`${baseUrl}?${params.toString()}`);
    if (!quote?.inAmount) return undefined;
    const priceImpactPct = Number(quote?.priceImpactPct ?? 0);
    if (!Number.isFinite(priceImpactPct) || priceImpactPct < 0) return undefined;
    return Math.round(priceImpactPct * 10_000);
  } catch {
    return undefined;
  }
}

type BuyRoute = Omit<JupiterRouteCheck, 'sellRouteAvailable'>;

async function hasJupiterSellRoute(
  tokenMint: string,
  outputMint: string,
  deps: JupiterDeps,
): Promise<boolean> {
  const { baseUrl, fetchJson } = resolveQuoteEndpoint(deps);
  const params = new URLSearchParams({
    inputMint: tokenMint,
    outputMint,
    // Tiny ExactIn probe. This only needs to prove a route exists; it avoids
    // token decimal lookups and supports Pump.fun AMMs that cannot quote ExactOut.
    amount: '1000',
    slippageBps: '500',
  });

  try {
    const quote = await fetchJson(`${baseUrl}?${params.toString()}`);
    return Boolean(quote?.outAmount);
  } catch {
    return false;
  }
}

export async function checkJupiterRoute(outputMint: string, deps: JupiterDeps = {}): Promise<JupiterRouteCheck> {
  const { baseUrl, fetchJson } = resolveQuoteEndpoint(deps);
  const availableRoutes: BuyRoute[] = [];

  for (const input of ROUTE_INPUTS) {
    const params = new URLSearchParams({
      inputMint: input.mint,
      outputMint,
      amount: String(input.amount),
      slippageBps: '500',
    });

    try {
      const quote = await fetchJson(`${baseUrl}?${params.toString()}`);
      if (!quote?.outAmount) continue;
      const priceImpactPct = Number(quote?.priceImpactPct ?? 1);
      availableRoutes.push({
        routeAvailable: true,
        estimatedSlippageBps: Math.max(0, Math.round(priceImpactPct * 10_000)),
        routeInputMint: input.mint,
        routeInputSymbol: input.symbol,
      });
    } catch {
      // Try the next route input.
    }
  }

  availableRoutes.sort((a, b) => a.estimatedSlippageBps - b.estimatedSlippageBps);
  const best: BuyRoute = availableRoutes[0] ?? { routeAvailable: false, estimatedSlippageBps: 10_000 };

  // Probe the sell direction back to the selected entry mint. Pump.fun AMM
  // routes often sell cleanly to SOL even when Jupiter cannot route token->USDC.
  const sellOutputMint = best.routeInputMint ?? USDC_MINT;
  return { ...best, sellRouteAvailable: best.routeAvailable && await hasJupiterSellRoute(outputMint, sellOutputMint, deps) };
}

async function defaultFetchJson(url: string, apiKey?: string): Promise<any> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Jupiter quote failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}
