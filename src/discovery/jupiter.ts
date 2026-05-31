interface JupiterDeps {
  fetchJson?: (url: string) => Promise<any>;
}

export interface JupiterRouteCheck {
  routeAvailable: boolean;
  estimatedSlippageBps: number;
  routeInputMint?: string;
  routeInputSymbol?: string;
}

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
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4DqE6P7ZX9HKo6uWjz3h',
    amount: 10_000_000,
  },
];

export async function checkJupiterRoute(outputMint: string, deps: JupiterDeps = {}): Promise<JupiterRouteCheck> {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const availableRoutes: JupiterRouteCheck[] = [];

  for (const input of ROUTE_INPUTS) {
    const params = new URLSearchParams({
      inputMint: input.mint,
      outputMint,
      amount: String(input.amount),
      slippageBps: '500',
    });

    try {
      const quote = await fetchJson(`https://quote-api.jup.ag/v6/quote?${params.toString()}`);
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

async function defaultFetchJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Jupiter quote failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}
