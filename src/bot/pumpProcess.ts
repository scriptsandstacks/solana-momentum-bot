import { fetchPumpPortalMarketCandidates } from './pumpCandidates.js';
import { checkJupiterRoute, type JupiterRouteCheck } from '../discovery/jupiter.js';
import { checkMintAuthority, type MintAuthorityInfo } from '../chains/solana/mintAuthority.js';
import { PaperBroker, type PaperBrokerOptions } from '../paper/paperBroker.js';
import { restoreBrokerFromStore, isBrokerStateStore } from '../paper/restoreBroker.js';
import { freshLaunchMomentumStrategy } from '../strategies/freshLaunchMomentum.js';
import type { TradingStrategy } from '../strategies/types.js';
import type { Reporter } from './reporter.js';
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
  // Ordered list of strategies. Each event is routed to the first strategy that
  // returns true from acceptsEventType(). Events with no matching strategy are
  // scored by the first strategy as a fallback. At minimum one strategy required.
  strategies?: TradingStrategy[];
  limit?: number;
  maxPendingAttempts?: number;
  fetchCandidates?: (tokenMints: string[]) => Promise<TokenCandidate[]>;
  checkRoute?: (outputMint: string) => Promise<JupiterRouteCheck>;
  // Injectable for testing; defaults to the real Solana RPC call.
  // Pass null to skip authority checks entirely (e.g. when no RPC URL is available).
  checkAuthority?: ((mint: string) => Promise<MintAuthorityInfo>) | null;
  reporter?: Reporter;
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

  // Use the provided strategy list or fall back to the singleton for backward compat.
  const strategies = options.strategies && options.strategies.length > 0
    ? options.strategies
    : [freshLaunchMomentumStrategy];

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

    // Route event to the appropriate strategy. First strategy whose acceptsEventType
    // returns true wins; falls back to the first strategy when none match.
    const strategy = strategies.find((s) => s.acceptsEventType(event.eventType)) ?? strategies[0];

    try {
      const route = await checkRoute(candidate.address);

      // Mint/freeze authority check — best-effort on-chain signal.
      // Runs when an explicit checkAuthority function is provided, or when
      // solanaConfig.rpcUrlEnv resolves to a URL in the environment.
      // Pass checkAuthority: null to explicitly disable the check.
      let authorityInfo: MintAuthorityInfo = { mintAuthorityRevoked: null, freezeAuthorityRevoked: null };
      if (options.checkAuthority !== null) {
        const rpcUrl = options.solanaConfig.rpcUrlEnv ? (process.env[options.solanaConfig.rpcUrlEnv] ?? undefined) : undefined;
        if (options.checkAuthority) {
          authorityInfo = await options.checkAuthority(candidate.address);
        } else if (rpcUrl) {
          authorityInfo = await checkMintAuthority(candidate.address, rpcUrl);
        }
        // No explicit function and no RPC URL configured → skip silently (unknown).
      }

      const enriched: TokenCandidate = strategy.tagCandidate({
        ...candidate,
        source: `${candidate.source}+${event.eventType}`,
        ...route,
        mintAuthorityRevoked: authorityInfo.mintAuthorityRevoked ?? undefined,
        freezeAuthorityRevoked: authorityInfo.freezeAuthorityRevoked ?? undefined,
      });
      const score = strategy.scoreCandidate(enriched);
      options.store.saveScoredCandidate(enriched, score);
      result.scored += 1;

      // Use strategy-specific entry threshold, not the global minimumScoreToEnter
      // (which is kept in options for the retry pass compatibility).
      const entryThreshold = strategy.config.minScoreToEnter;
      let note = `strategy=${strategy.id} score=${score.total} recommendation=${score.recommendation}`;
      if (score.total >= entryThreshold && score.recommendation === 'paper_trade') {
        // Size the position by the strategy's conviction tier before capacity check
        // so we know how much cash is required.
        const positionSizeUsd = strategy.resolvePositionSizeUsd(score.total, options.paper.positionSizeUsd);
        const capacity = broker.canOpenPosition(undefined, positionSizeUsd);
        if (capacity.ok) {
          const position = broker.openPosition(enriched, score.total, undefined, positionSizeUsd);
          options.store.saveOpenPosition(position);
          options.reporter?.onPositionOpened?.({ position, strategyId: strategy.id });
          result.openedPositions += 1;
          note += ` opened sizeUsd=${positionSizeUsd.toFixed(2)}`;
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
