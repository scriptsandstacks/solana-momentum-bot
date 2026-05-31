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
}

// Quote API V6 (`quote-api.jup.ag/v6`) was deprecated on 2025-10-01. The forward
// path is the Swap API on api.jup.ag; the query params are unchanged, only the
// host moved. Free usage requires an API key (x-api-key header) generated at
// https://portal.jup.ag. The keyless lite-api.jup.ag still works during the
// grace period and can be selected via JUPITER_QUOTE_URL.
const DEFAULT_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';

const ROUTE_INPUTS = [
  {
    symbol: 'SOL',
    mint: 'So11111111111111111111111111111111111111112',
    amount: 10_000_000,
  },
  {
    symbol: 'USDC',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amount: 10_000_000,
  },
  {
    symbol: 'USDT',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY2Sr6MGt9RktwD',
    amount: 10_000_000,
  },
];

export async function checkJupiterRoute(outputMint: string, deps: JupiterDeps = {}): Promise<JupiterRouteCheck> {
  const apiKey = deps.apiKey ?? process.env.JUPITER_API_KEY;
  const baseUrl = deps.baseUrl ?? process.env.JUPITER_QUOTE_URL ?? DEFAULT_QUOTE_URL;
  const fetchJson = deps.fetchJson ?? ((url: string) => defaultFetchJson(url, apiKey));
  const availableRoutes: JupiterRouteCheck[] = [];

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
  return availableRoutes[0] ?? { routeAvailable: false, estimatedSlippageBps: 10_000 };
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
