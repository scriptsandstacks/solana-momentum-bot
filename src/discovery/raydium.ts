import type { TokenCandidate } from '../types/domain.js';

const SOLANA_STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY2Sr6MGt9RktwD', // USDT
]);

interface RaydiumMintInfo {
  address?: string;
  symbol?: string;
  name?: string;
}

export interface RaydiumPool {
  id?: string;
  mintA?: RaydiumMintInfo;
  mintB?: RaydiumMintInfo;
  price?: number | string;
  tvl?: number;
  day?: { volume?: number };
  openTime?: string | number;
}

type FetchJson = (url: string) => Promise<any>;

export function mapRaydiumPoolToCandidate(pool: RaydiumPool, requestedMint: string): TokenCandidate {
  const matchesMintA = pool.mintA?.address === requestedMint;
  const matchesMintB = pool.mintB?.address === requestedMint;
  const token = matchesMintA ? pool.mintA : matchesMintB ? pool.mintB : undefined;
  const openedMs = Number(pool.openTime ?? 0) > 0 ? Number(pool.openTime) * 1000 : Date.now();
  const ageMinutes = Math.max(0, Math.floor((Date.now() - openedMs) / 60_000));
  const dayVolume = Number(pool.day?.volume ?? 0);

  return {
    chain: 'solana',
    address: token?.address ?? '',
    symbol: token?.symbol ?? 'UNKNOWN',
    name: token?.name ?? token?.symbol ?? 'Unknown Token',
    pairAddress: pool.id ?? '',
    priceUsd: normalizeRaydiumPrice(pool, requestedMint),
    liquidityUsd: Number(pool.tvl ?? 0),
    volume5mUsd: roundUsd(dayVolume / 288),
    volume1hUsd: roundUsd(dayVolume / 24),
    priceChange5mPct: 0,
    buys5m: 0,
    sells5m: 0,
    ageMinutes,
    source: 'raydium',
    routeAvailable: false,
    estimatedSlippageBps: 10_000,
  };
}

export async function fetchRaydiumSolanaTokenCandidates(
  tokenMints: string[],
  fetchJson: FetchJson = defaultFetchJson,
): Promise<TokenCandidate[]> {
  const uniqueMints = [...new Set(tokenMints.filter(Boolean))];
  const bestByMint = new Map<string, TokenCandidate>();

  for (const mint of uniqueMints) {
    const url = buildRaydiumMintPoolsUrl(mint);
    try {
      const data = await fetchJson(url);
      const pools = Array.isArray(data?.data?.data) ? data.data.data : [];
      for (const pool of pools) {
        const candidate = mapRaydiumPoolToCandidate(pool, mint);
        if (!candidate.address || !candidate.pairAddress) continue;
        if (candidate.priceUsd <= 0 || candidate.liquidityUsd <= 0) continue;
        const existing = bestByMint.get(candidate.address);
        if (!existing || candidate.liquidityUsd > existing.liquidityUsd) {
          bestByMint.set(candidate.address, candidate);
        }
      }
    } catch {
      // Best-effort enrichment: one Raydium mint lookup must not kill the whole batch.
    }
  }

  return [...bestByMint.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

function buildRaydiumMintPoolsUrl(mint: string): string {
  const params = new URLSearchParams({
    mint1: mint,
    poolType: 'all',
    poolSortField: 'liquidity',
    sortType: 'desc',
    pageSize: '10',
    page: '1',
  });
  return `https://api-v3.raydium.io/pools/info/mint?${params.toString()}`;
}

function normalizeRaydiumPrice(pool: RaydiumPool, requestedMint: string): number {
  const price = Number(pool.price ?? 0);
  if (!Number.isFinite(price) || price <= 0) return 0;

  // Raydium reports `price` as the mintB/mintA ratio. We can only convert it
  // into a USD price when the opposite side of the requested mint is a
  // recognized USD stablecoin. For all other pairings (SOL, ETH, exotic
  // quotes) we have no on-pool USD reference, so we return 0 and let the
  // candidate be filtered. PaperBroker.openPosition divides positionSizeUsd by
  // priceUsd, so a wrong price corrupts paper PnL — better to drop the signal.
  if (pool.mintA?.address === requestedMint && SOLANA_STABLE_MINTS.has(pool.mintB?.address ?? '')) return price;
  if (pool.mintB?.address === requestedMint && SOLANA_STABLE_MINTS.has(pool.mintA?.address ?? '')) return 1 / price;
  return 0;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

async function defaultFetchJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Raydium request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}
