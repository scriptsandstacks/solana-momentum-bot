import type { TokenCandidate } from '../types/domain.js';

type DexChainId = 'solana' | 'base' | 'ethereum';

interface DexScreenerPair {
  chainId: string;
  pairAddress?: string;
  baseToken?: {
    address?: string;
    symbol?: string;
    name?: string;
  };
  priceUsd?: string | number;
  liquidity?: { usd?: number };
  volume?: { m5?: number; h1?: number };
  priceChange?: { m5?: number };
  txns?: { m5?: { buys?: number; sells?: number } };
  pairCreatedAt?: number;
}

function toSupportedChain(chainId: string): DexChainId {
  if (chainId === 'solana' || chainId === 'base' || chainId === 'ethereum') {
    return chainId;
  }
  throw new Error(`Unsupported DexScreener chain: ${chainId}`);
}

export function mapDexScreenerPairToCandidate(pair: DexScreenerPair): TokenCandidate {
  const createdAt = pair.pairCreatedAt ?? Date.now();
  const ageMinutes = Math.max(0, Math.floor((Date.now() - createdAt) / 60_000));
  const priceUsd = Number(pair.priceUsd ?? 0);

  return {
    chain: toSupportedChain(pair.chainId),
    address: pair.baseToken?.address ?? '',
    symbol: pair.baseToken?.symbol ?? 'UNKNOWN',
    name: pair.baseToken?.name ?? pair.baseToken?.symbol ?? 'Unknown Token',
    pairAddress: pair.pairAddress ?? '',
    priceUsd,
    liquidityUsd: pair.liquidity?.usd ?? 0,
    volume5mUsd: pair.volume?.m5 ?? 0,
    volume1hUsd: pair.volume?.h1 ?? 0,
    priceChange5mPct: pair.priceChange?.m5 ?? 0,
    buys5m: pair.txns?.m5?.buys ?? 0,
    sells5m: pair.txns?.m5?.sells ?? 0,
    ageMinutes,
    source: 'dexscreener',
    routeAvailable: false,
    estimatedSlippageBps: 10_000,
  };
}

const SOLANA_DISCOVERY_QUERIES = ['SOL', 'pump', 'raydium', 'meteora', 'orca'];

export async function fetchDexScreenerSolanaPairs(fetchJson = defaultFetchJson): Promise<TokenCandidate[]> {
  const allPairs: DexScreenerPair[] = [];
  for (const query of SOLANA_DISCOVERY_QUERIES) {
    const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
    try {
      const data = await fetchJson(url);
      allPairs.push(...(Array.isArray(data?.pairs) ? data.pairs : []));
    } catch {
      // Best-effort discovery: one slow/limited search must not kill the whole scan.
    }
  }

  const deduped = new Map<string, TokenCandidate>();
  for (const pair of allPairs) {
    if (pair.chainId !== 'solana') continue;
    const candidate = mapDexScreenerPairToCandidate(pair);
    if (!candidate.address || !candidate.pairAddress || candidate.priceUsd <= 0) continue;
    const existing = deduped.get(candidate.pairAddress);
    if (!existing || candidate.liquidityUsd > existing.liquidityUsd) {
      deduped.set(candidate.pairAddress, candidate);
    }
  }

  return [...deduped.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

export async function fetchDexScreenerLatestSolanaPairs(fetchJson = defaultFetchJson): Promise<TokenCandidate[]> {
  return fetchDexScreenerSolanaPairs(fetchJson);
}

export async function fetchDexScreenerSolanaTokenCandidates(
  tokenMints: string[],
  fetchJson = defaultFetchJson,
): Promise<TokenCandidate[]> {
  const uniqueMints = [...new Set(tokenMints.filter(Boolean))];
  if (uniqueMints.length === 0) return [];

  const candidates: TokenCandidate[] = [];
  for (const chunk of chunkArray(uniqueMints, 30)) {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk.map(encodeURIComponent).join(',')}`;
    try {
      const data = await fetchJson(url);
      const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
      for (const pair of pairs) {
        if (pair.chainId !== 'solana') continue;
        const candidate = mapDexScreenerPairToCandidate(pair);
        if (!candidate.address || !candidate.pairAddress || candidate.priceUsd <= 0) continue;
        candidates.push({ ...candidate, source: 'pumpportal+dexscreener' });
      }
    } catch {
      // Best-effort enrichment: one failed token chunk must not kill the whole batch.
    }
  }

  const bestByMint = new Map<string, TokenCandidate>();
  for (const candidate of candidates) {
    const existing = bestByMint.get(candidate.address);
    if (!existing || candidate.liquidityUsd > existing.liquidityUsd) {
      bestByMint.set(candidate.address, candidate);
    }
  }

  return [...bestByMint.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function defaultFetchJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`DexScreener request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}
