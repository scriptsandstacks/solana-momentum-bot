import type { ChainConfig } from '../../config/schema.js';
import { fetchDexScreenerLatestSolanaPairs } from '../../discovery/dexscreener.js';
import { checkJupiterRoute } from '../../discovery/jupiter.js';
import type { TokenCandidate } from '../../types/domain.js';

export async function scanSolanaCandidates(config: ChainConfig): Promise<TokenCandidate[]> {
  const candidates = await fetchDexScreenerLatestSolanaPairs();
  const viable = candidates.filter(
    (candidate) => candidate.liquidityUsd >= config.minLiquidityUsd && candidate.volume5mUsd >= config.minVolume5mUsd,
  );

  const enriched: TokenCandidate[] = [];
  for (const candidate of viable.slice(0, 25)) {
    const route = await checkJupiterRoute(candidate.address);
    enriched.push({ ...candidate, ...route });
  }

  return enriched;
}
