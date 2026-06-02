import { restoreBrokerFromStore, isBrokerStateStore, type BrokerStateStore } from '../paper/restoreBroker.js';
import type { PaperBrokerOptions } from '../paper/paperBroker.js';
import type { PaperPosition, TokenCandidate } from '../types/domain.js';
import type { RetriableScoredCandidateRow } from '../storage/sqliteStore.js';
import type { ChainName } from '../config/schema.js';
import type { TradingStrategy } from '../strategies/types.js';

// Minimal store interface required to run the retry pass.
export interface RetryBlockedOpensStore extends BrokerStateStore {
  listRetriableScoredCandidates(options: {
    minScore: number;
    cutoffIso: string;
    limit?: number;
    strategyMinScores?: Record<string, number>;
  }): RetriableScoredCandidateRow[];
  saveOpenPosition(position: PaperPosition): void;
}

export interface RetryBlockedOpensResult {
  candidates: number;
  openedPositions: number;
  skippedRefresh: number;
}

export type RetryCandidateRefresher = (candidate: TokenCandidate) => Promise<TokenCandidate | undefined>;

// After the exit pass frees broker capacity, try to fill it with recently
// scored candidates that were never opened (most likely blocked by the cap at
// scoring time). Uses the scored price as the paper entry — no re-fetch — so
// this is only called within the trade horizon window (cutoffIso derived from
// maxHoldMinutes) where the price is still a reasonable approximation.
export async function retryBlockedOpens(options: {
  store: RetryBlockedOpensStore;
  paper: PaperBrokerOptions;
  minimumScoreToEnter: number;
  strategies?: TradingStrategy[];
  cutoffIso: string;
  limit?: number;
  refreshCandidate?: RetryCandidateRefresher;
}): Promise<RetryBlockedOpensResult> {
  const minScoreByStrategy = new Map(options.strategies?.map((strategy) => [strategy.id, strategy.config.minScoreToEnter]) ?? []);
  const queryMinScore =
    minScoreByStrategy.size > 0
      ? Math.min(...minScoreByStrategy.values())
      : options.minimumScoreToEnter;
  const rows = options.store.listRetriableScoredCandidates({
    minScore: queryMinScore,
    cutoffIso: options.cutoffIso,
    limit: options.limit ?? 10,
    strategyMinScores: Object.fromEntries(minScoreByStrategy),
  }).filter((row) => row.score >= (minScoreByStrategy.get(row.strategyId) ?? options.minimumScoreToEnter));

  const result: RetryBlockedOpensResult = { candidates: rows.length, openedPositions: 0, skippedRefresh: 0 };
  if (rows.length === 0) return result;

  const broker = restoreBrokerFromStore(options.store, options.paper);

  for (const row of rows) {
    const capacity = broker.canOpenPosition();
    if (!capacity.ok) break; // still at capacity — no point continuing

    const storedCandidate = rowToCandidate(row);
    const candidate = options.refreshCandidate
      ? mergeRefreshedCandidate(storedCandidate, await options.refreshCandidate(storedCandidate))
      : storedCandidate;
    if (!candidate) {
      result.skippedRefresh += 1;
      continue;
    }
    const position = broker.openPosition(candidate, row.score);
    options.store.saveOpenPosition(position);
    result.openedPositions += 1;
  }

  return result;
}

function mergeRefreshedCandidate(stored: TokenCandidate, refreshed: TokenCandidate | undefined): TokenCandidate | undefined {
  if (!refreshed) return undefined;
  return {
    ...stored,
    ...refreshed,
    strategyId: stored.strategyId,
    mintAuthorityRevoked: stored.mintAuthorityRevoked,
    freezeAuthorityRevoked: stored.freezeAuthorityRevoked,
    top5HolderPct: stored.top5HolderPct,
    volumeAcceleration5mZ: stored.volumeAcceleration5mZ,
    volumeAccelerationSamples: stored.volumeAccelerationSamples,
  };
}

export function canRetryBlockedOpens(store: unknown): store is RetryBlockedOpensStore {
  return (
    isBrokerStateStore(store) &&
    typeof (store as RetryBlockedOpensStore).listRetriableScoredCandidates === 'function' &&
    typeof (store as RetryBlockedOpensStore).saveOpenPosition === 'function'
  );
}

function rowToCandidate(row: RetriableScoredCandidateRow): TokenCandidate {
  return {
    chain: row.chain as ChainName,
    address: row.address,
    symbol: row.symbol,
    name: row.name,
    pairAddress: row.pairAddress,
    priceUsd: row.priceUsd,
    liquidityUsd: row.liquidityUsd,
    volume5mUsd: row.volume5mUsd,
    volume1hUsd: row.volume1hUsd,
    priceChange5mPct: row.priceChange5mPct,
    buys5m: row.buys5m,
    sells5m: row.sells5m,
    ageMinutes: row.ageMinutes,
    source: row.source,
    routeAvailable: row.routeAvailable === 1,
    estimatedSlippageBps: row.estimatedSlippageBps,
    routeInputMint: row.routeInputMint ?? undefined,
    routeInputSymbol: row.routeInputSymbol ?? undefined,
    strategyId: row.strategyId,
    sellRouteAvailable: row.sellRouteAvailable === null ? undefined : row.sellRouteAvailable === 1,
    mintAuthorityRevoked: row.mintAuthorityRevoked === null ? undefined : row.mintAuthorityRevoked === 1,
    freezeAuthorityRevoked: row.freezeAuthorityRevoked === null ? undefined : row.freezeAuthorityRevoked === 1,
    top5HolderPct: row.top5HolderPct ?? undefined,
    volumeAcceleration5mZ: row.volumeAcceleration5mZ ?? undefined,
    volumeAccelerationSamples: row.volumeAccelerationSamples ?? undefined,
  };
}
