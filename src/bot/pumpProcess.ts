import { fetchPumpPortalMarketCandidates } from './pumpCandidates.js';
import { checkJupiterRoute, type JupiterRouteCheck } from '../discovery/jupiter.js';
import { PaperBroker, type PaperBrokerOptions } from '../paper/paperBroker.js';
import { restoreBrokerFromStore, isBrokerStateStore } from '../paper/restoreBroker.js';
import { scoreTokenCandidate } from '../scoring/scoreToken.js';
import type { ChainConfig } from '../config/schema.js';
import type { OpportunityScore, PaperPosition, TokenCandidate } from '../types/domain.js';

interface PumpPortalEventRow {
  id: number;
  eventType: string;
  tokenMint?: string;
  symbol?: string;
  name?: string;
  signature?: string;
  rawJson: string;
  receivedAt: string;
  processingAttempts?: number;
}

// Cap how many times we re-queue a fresh mint with no DexScreener/Raydium data.
// Without this, abandoned mints stay in the queue forever and burn enrichment
// API budget on every interval tick.
const DEFAULT_MAX_PENDING_ATTEMPTS = 5;

interface PumpProcessStore {
  listPendingPumpPortalEvents(limit?: number): PumpPortalEventRow[];
  markPumpPortalEventProcessed(id: number, status: 'pending' | 'processed' | 'skipped' | 'failed', note?: string): void;
  saveScoredCandidate(candidate: TokenCandidate, score: OpportunityScore): void;
  saveOpenPosition(position: PaperPosition): void;
}

interface PumpProcessOptions {
  store: PumpProcessStore;
  solanaConfig: ChainConfig;
  paper: PaperBrokerOptions;
  minimumScoreToEnter: number;
  limit?: number;
  maxPendingAttempts?: number;
  fetchCandidates?: (tokenMints: string[]) => Promise<TokenCandidate[]>;
  checkRoute?: (outputMint: string) => Promise<JupiterRouteCheck>;
}

export interface PumpProcessResult {
  eventsRead: number;
  candidatesEnriched: number;
  scored: number;
  openedPositions: number;
  skipped: number;
  failed: number;
}

export async function processPumpPortalEvents(options: PumpProcessOptions): Promise<PumpProcessResult> {
  const events = options.store.listPendingPumpPortalEvents(options.limit ?? 50);
  const result: PumpProcessResult = {
    eventsRead: events.length,
    candidatesEnriched: 0,
    scored: 0,
    openedPositions: 0,
    skipped: 0,
    failed: 0,
  };

  if (events.length === 0) return result;

  const mints = [...new Set(events.map((event) => event.tokenMint).filter((mint): mint is string => Boolean(mint)))];
  const fetchCandidates = options.fetchCandidates ?? fetchPumpPortalMarketCandidates;
  const checkRoute = options.checkRoute ?? checkJupiterRoute;
  const candidates = await fetchCandidates(mints);
  const candidatesByMint = new Map(candidates.map((candidate) => [candidate.address, candidate]));
  result.candidatesEnriched = candidates.length;

  // Rehydrate the broker from persisted state so cash, the position cap, and the
  // daily-loss breaker stay correct across passes/restarts. Fall back to a fresh
  // broker for minimal stores (e.g. unit tests) that don't expose state reads.
  const broker = isBrokerStateStore(options.store)
    ? restoreBrokerFromStore(options.store, options.paper)
    : new PaperBroker(options.paper);

  for (const event of events) {
    if (!event.tokenMint) {
      options.store.markPumpPortalEventProcessed(event.id, 'skipped', 'missing token mint');
      result.skipped += 1;
      continue;
    }

    const candidate = candidatesByMint.get(event.tokenMint);
    if (!candidate) {
      const maxAttempts = options.maxPendingAttempts ?? DEFAULT_MAX_PENDING_ATTEMPTS;
      const previousAttempts = event.processingAttempts ?? 0;
      if (previousAttempts >= maxAttempts) {
        options.store.markPumpPortalEventProcessed(
          event.id,
          'skipped',
          `max retries reached (${maxAttempts}) with no market data`,
        );
      } else {
        options.store.markPumpPortalEventProcessed(event.id, 'pending', 'no DexScreener market data yet');
      }
      result.skipped += 1;
      continue;
    }

    if (candidate.liquidityUsd < options.solanaConfig.minLiquidityUsd) {
      options.store.markPumpPortalEventProcessed(event.id, 'skipped', 'below configured liquidity threshold');
      result.skipped += 1;
      continue;
    }

    if (candidate.volume5mUsd < options.solanaConfig.minVolume5mUsd) {
      options.store.markPumpPortalEventProcessed(event.id, 'skipped', 'below configured 5m volume threshold');
      result.skipped += 1;
      continue;
    }

    try {
      const route = await checkRoute(candidate.address);
      const enriched: TokenCandidate = {
        ...candidate,
        source: `${candidate.source}+${event.eventType}`,
        ...route,
      };
      const score = scoreTokenCandidate(enriched);
      options.store.saveScoredCandidate(enriched, score);
      result.scored += 1;

      let note = `score=${score.total} recommendation=${score.recommendation}`;
      if (score.total >= options.minimumScoreToEnter && score.recommendation === 'paper_trade') {
        // A blocked entry (cap/cash/daily-loss) is an expected outcome, not a
        // failure: still mark the event processed, just note why we held off.
        const capacity = broker.canOpenPosition();
        if (capacity.ok) {
          const position = broker.openPosition(enriched, score.total);
          options.store.saveOpenPosition(position);
          result.openedPositions += 1;
          note += ' opened';
        } else {
          note += ` not opened (${capacity.reason})`;
        }
      }

      options.store.markPumpPortalEventProcessed(event.id, 'processed', note);
    } catch (error) {
      options.store.markPumpPortalEventProcessed(
        event.id,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
      result.failed += 1;
    }
  }

  return result;
}
