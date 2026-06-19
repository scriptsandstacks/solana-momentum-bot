import { fetchDexScreenerSolanaTokenCandidates } from '../discovery/dexscreener.js';
import { fetchRaydiumSolanaTokenCandidates } from '../discovery/raydium.js';
import type { TokenCandidate } from '../types/domain.js';

type CandidateFetcher = (tokenMints: string[]) => Promise<TokenCandidate[]>;

const ROUTE_INPUT_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY2Sr6MGt9RktwD',
]);

export async function fetchPumpPortalMarketCandidates(
  tokenMints: string[],
  fetchDexScreenerCandidates: CandidateFetcher = fetchDexScreenerSolanaTokenCandidates,
  fetchRaydiumCandidates: CandidateFetcher = fetchRaydiumSolanaTokenCandidates,
): Promise<TokenCandidate[]> {
  const targetMints = tokenMints.filter((mint) => !ROUTE_INPUT_MINTS.has(mint));
  const [dexCandidates, raydiumCandidates] = await Promise.all([
    fetchDexScreenerCandidates(targetMints),
    fetchRaydiumCandidates(targetMints),
  ]);

  const byMint = new Map<string, TokenCandidate[]>();
  for (const candidate of [...dexCandidates, ...raydiumCandidates]) {
    if (ROUTE_INPUT_MINTS.has(candidate.address)) continue;
    const group = byMint.get(candidate.address) ?? [];
    group.push(candidate);
    byMint.set(candidate.address, group);
  }

  return [...byMint.values()].map(mergeCandidatesForMint).sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

// DexScreener carries real trade-level activity (5m volume, buy/sell counts,
// momentum); Raydium's pool endpoint does not, so it reports zeroed/synthetic
// values for those. Detect a source that has the live signal so a deeper
// Raydium pool's blanks don't overwrite it.
function hasRealActivity(candidate: TokenCandidate): boolean {
  return candidate.source.includes('dexscreener');
}

// Merge the candidates discovered for one mint into the single best view:
// price/liquidity/pair from the deepest (most tradable) pool, but volume, buy/
// sell counts, and momentum from a source that actually reports them. Letting
// a deeper Raydium pool win on liquidity must not blank out DexScreener's live
// activity, or fresh Raydium-led mints get filtered/scored as if they were dead.
function mergeCandidatesForMint(group: TokenCandidate[]): TokenCandidate {
  const deepest = group.reduce((best, candidate) =>
    candidate.liquidityUsd > best.liquidityUsd ? candidate : best,
  );
  const activity = group.find(hasRealActivity) ?? deepest;
  const sources = new Set(group.flatMap((candidate) => candidate.source.split('+')));

  return {
    ...deepest,
    volume5mUsd: activity.volume5mUsd,
    volume1hUsd: activity.volume1hUsd,
    priceChange5mPct: activity.priceChange5mPct,
    buys5m: activity.buys5m,
    sells5m: activity.sells5m,
    ageMinutes: Math.min(deepest.ageMinutes, activity.ageMinutes),
    source: [...sources].join('+'),
  };
}
