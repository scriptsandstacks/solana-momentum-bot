import { fetchDexScreenerSolanaTokenCandidates } from '../discovery/dexscreener.js';
import { fetchRaydiumSolanaTokenCandidates } from '../discovery/raydium.js';
import type { TokenCandidate } from '../types/domain.js';

type CandidateFetcher = (tokenMints: string[]) => Promise<TokenCandidate[]>;

export async function fetchPumpPortalMarketCandidates(
  tokenMints: string[],
  fetchDexScreenerCandidates: CandidateFetcher = fetchDexScreenerSolanaTokenCandidates,
  fetchRaydiumCandidates: CandidateFetcher = fetchRaydiumSolanaTokenCandidates,
): Promise<TokenCandidate[]> {
  const [dexCandidates, raydiumCandidates] = await Promise.all([
    fetchDexScreenerCandidates(tokenMints),
    fetchRaydiumCandidates(tokenMints),
  ]);

  const bestByMint = new Map<string, TokenCandidate>();
  for (const candidate of [...dexCandidates, ...raydiumCandidates]) {
    const existing = bestByMint.get(candidate.address);
    if (!existing || candidate.liquidityUsd > existing.liquidityUsd) {
      bestByMint.set(candidate.address, mergeSource(candidate, existing));
    }
  }

  return [...bestByMint.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

function mergeSource(candidate: TokenCandidate, previous?: TokenCandidate): TokenCandidate {
  if (!previous) return candidate;
  const sources = new Set([...previous.source.split('+'), ...candidate.source.split('+')]);
  return { ...candidate, source: [...sources].join('+') };
}
