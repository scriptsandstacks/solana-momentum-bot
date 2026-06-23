import { PumpPortalClient, type PumpPortalRawEvent } from '../discovery/pumpPortal.js';
import { processPumpPortalEvents, type PumpProcessResult } from './pumpProcess.js';
import { processExits as processExitsImpl, type ExitRules, type ProcessExitsResult } from './exitPositions.js';
import { trackCandidateOutcomes as trackCandidateOutcomesImpl, type TrackOutcomesResult } from './trackOutcomes.js';
import { retryBlockedOpens as retryBlockedOpensImpl, canRetryBlockedOpens, type RetryBlockedOpensResult } from './retryBlockedOpens.js';
import { computeTradeAnalytics, renderAnalyticsReport } from './analytics.js';
import { fetchPumpPortalMarketCandidates } from './pumpCandidates.js';
import { isBrokerStateStore, restoreBrokerFromStore } from '../paper/restoreBroker.js';
import type { ExecutionBroker } from '../execution/broker.js';
import { checkJupiterRoute } from '../discovery/jupiter.js';
import type { Reporter } from './reporter.js';
import type { TradingStrategy } from '../strategies/types.js';
import type { ChainConfig } from '../config/schema.js';
import type { PaperBrokerOptions } from '../paper/paperBroker.js';
import type { OpportunityScore, PaperPosition, PaperTrade, TokenCandidate } from '../types/domain.js';
import type { BotRuntimeStatusUpdate, ScoredOutcomeUpdate, TrackableScoredCandidateRow, RetriableScoredCandidateRow, ClosedTradeStatRow } from '../storage/sqliteStore.js';

interface RunLoopStore {
  savePumpPortalEvent(event: PumpPortalRawEvent): void;
  listPendingPumpPortalEvents?(limit?: number): Array<{
    id: number;
    eventType: string;
    tokenMint?: string;
    symbol?: string;
    name?: string;
    signature?: string;
    rawJson: string;
    receivedAt: string;
  }>;
  listPendingPumpPortalEventsForTrading?(limit?: number): Array<{
    id: number;
    eventType: string;
    tokenMint?: string;
    symbol?: string;
    name?: string;
    signature?: string;
    rawJson: string;
    receivedAt: string;
    processingAttempts?: number;
  }>;
  markPumpPortalEventProcessed?(id: number, status: 'pending' | 'processed' | 'skipped' | 'failed', note?: string): void;
  saveScoredCandidate?(candidate: TokenCandidate, score: OpportunityScore): void;
  saveOpenPosition?(position: PaperPosition): void;
  saveClosedTrade?(trade: PaperTrade): void;
  // Broker-state reads, present on the real SqliteStore. When all are present
  // (see isBrokerStateStore) the run loop enables the per-interval exit pass.
  loadOpenPositions?(): PaperPosition[];
  getRealizedPnlUsd?(): number;
  getRealizedPnlUsdSince?(sinceIso: string): number;
  getNextPositionSeq?(): number;
  // Scored-candidate outcome tracking. When all are present the run loop also
  // re-prices recently scored candidates to capture forward MFE/MAE.
  listTrackableScoredCandidates?(limit?: number): TrackableScoredCandidateRow[];
  markStaleScoredOutcomesDone?(cutoffIso: string): number;
  recordScoredOutcome?(update: ScoredOutcomeUpdate): void;
  // Retry pass: re-opens positions for capacity-blocked scored candidates.
  listRetriableScoredCandidates?(options: {
    minScore: number;
    cutoffIso: string;
    limit?: number;
    strategyMinScores?: Record<string, number>;
  }): RetriableScoredCandidateRow[];
  // Analytics: when present the run loop can emit periodic performance summaries.
  loadClosedTradeStats?(): ClosedTradeStatRow[];
  // Data retention: when present the run loop auto-prunes once per UTC day.
  pruneScoredCandidates?(cutoffIso: string): number;
  pruneTokenVolumeSnapshots?(cutoffIso: string): number;
  prunePumpPortalEvents?(cutoffIso: string): number;
  // Runtime heartbeat: one status row for UI/API health checks that should not
  // infer process liveness from scored-candidate activity.
  recordBotRuntimeStatus?(update: BotRuntimeStatusUpdate): void;
}

type ProcessExits = (options: {
  store: RunLoopStore;
  paper: PaperBrokerOptions;
  exits: ExitRules;
  resolveExits?: (strategyId: string | undefined) => ExitRules | undefined;
  reporter?: Reporter;
  broker?: ExecutionBroker;
  onLog?: (message: string) => void;
}) => Promise<ProcessExitsResult>;

function canProcessExits(store: RunLoopStore): boolean {
  return isBrokerStateStore(store) && typeof store.saveOpenPosition === 'function' && typeof store.saveClosedTrade === 'function';
}

function canTrackOutcomes(store: RunLoopStore): boolean {
  return (
    typeof store.listTrackableScoredCandidates === 'function' &&
    typeof store.markStaleScoredOutcomesDone === 'function' &&
    typeof store.recordScoredOutcome === 'function'
  );
}

type TrackOutcomes = (options: {
  store: RunLoopStore;
  horizonMinutes: number;
  thresholds?: { takeProfitPct: number; stopLossPct: number };
}) => Promise<TrackOutcomesResult>;

type RetryBlockedOpens = (options: {
  store: RunLoopStore;
  paper: PaperBrokerOptions;
  minimumScoreToEnter: number;
  strategies?: TradingStrategy[];
  cutoffIso: string;
  refreshCandidate?: (candidate: TokenCandidate) => Promise<TokenCandidate | undefined>;
  broker?: ExecutionBroker;
}) => Promise<RetryBlockedOpensResult>;

async function refreshRetryCandidate(candidate: TokenCandidate): Promise<TokenCandidate | undefined> {
  const refreshed = (await fetchPumpPortalMarketCandidates([candidate.address]))[0];
  if (!refreshed) return undefined;
  const route = await checkJupiterRoute(candidate.address);
  return { ...refreshed, ...route };
}

type PumpPortalClientLike = {
  connectFreeStreams(): Promise<void>;
  close(): void;
};

type PumpPortalClientCtor = new (options: {
  apiKey: string;
  onEvent?: (event: PumpPortalRawEvent) => void;
  onError?: (error: unknown) => void;
  onLog?: (message: string) => void;
}) => PumpPortalClientLike;

type ProcessPumpEvents = (options: {
  store: RunLoopStore;
  solanaConfig: ChainConfig;
  paper: PaperBrokerOptions;
  minimumScoreToEnter: number;
  strategies?: TradingStrategy[];
  limit?: number;
  maxTradeEventAgeMinutes?: number;
  maxPendingAttempts?: number;
  reporter?: Reporter;
  broker?: ExecutionBroker;
}) => Promise<PumpProcessResult>;

interface RunBotLoopOptions {
  apiKey?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  durationMs?: number;
  processIntervalMs: number;
  processLimit: number;
  maxTradeEventAgeMinutes?: number;
  maxPendingAttempts?: number;
  store: RunLoopStore;
  solanaConfig: ChainConfig;
  paper: PaperBrokerOptions;
  minimumScoreToEnter: number;
  // Active strategies for event routing. When provided, each event is routed to
  // the first strategy that accepts its event type.
  strategies?: TradingStrategy[];
  // When provided, each processing pass also re-prices open positions and
  // applies these exit rules. Omitted in tests that only exercise discovery.
  exits?: ExitRules;
  // Per-strategy exit override resolver. Passed through to processExits so each
  // position is evaluated against its strategy's exit thresholds, not just globals.
  resolveExits?: (strategyId: string | undefined) => ExitRules | undefined;
  // Emit a full analytics summary via onLog every N process passes. 0 = disabled.
  analyticsIntervalPasses?: number;
  // Data-retention windows. When set and the store supports pruning, the run
  // loop prunes once per UTC day automatically so disk never grows unboundedly.
  retention?: {
    scoredCandidateDays: number;
    pumpPortalEventDays: number;
    volumeSnapshotDays: number;
  };
  ClientCtor?: PumpPortalClientCtor;
  processPumpEvents?: ProcessPumpEvents;
  processExits?: ProcessExits;
  trackOutcomes?: TrackOutcomes;
  retryBlockedOpens?: RetryBlockedOpens;
  stopSignal?: AbortSignal;
  onLog?: (message: string) => void;
  reporter?: Reporter;
  // When provided, passed to every sub-pass so live mode uses one long-lived
  // broker rather than reconstructing a PaperBroker from store each interval.
  broker?: ExecutionBroker;
  // When set, exit evaluations also run on this separate, tighter interval so
  // live positions are protected on timescales shorter than processIntervalMs.
  // Exit passes running on this interval skip if a main process pass is in flight.
  exitIntervalMs?: number;
  // Factory that, given an activity handler, returns a token watcher. The run
  // loop calls watch(mint)/unwatch(mint) as positions open and close, and the
  // handler triggers an immediate exit check when on-chain activity is detected.
  // Only used when broker is provided (live mode).
  createTokenWatcher?: (onActivity: (mint: string) => void) => {
    watch(mint: string): void;
    unwatch(mint: string): void;
    close(): void;
  };
}

export interface RunBotLoopResult {
  eventsSaved: number;
  processRuns: number;
  eventsRead: number;
  candidatesEnriched: number;
  scored: number;
  openedPositions: number;
  skipped: number;
  failed: number;
  closedPositions: number;
  retriedPositions: number;
  outcomesUpdated: number;
}

export function resolveRunLoopApiKey(
  explicitApiKey?: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const apiKey = explicitApiKey ?? env.PUMPPORTAL_API_KEY;
  if (!apiKey) {
    throw new Error('Missing PumpPortal API key. Set PUMPPORTAL_API_KEY or pass --api-key.');
  }
  return apiKey;
}

export async function runBotLoop(options: RunBotLoopOptions): Promise<RunBotLoopResult> {
  if (!Number.isFinite(options.processIntervalMs) || options.processIntervalMs <= 0) {
    throw new Error('processIntervalMs must be a positive number');
  }
  if (!Number.isFinite(options.processLimit) || options.processLimit <= 0) {
    throw new Error('processLimit must be a positive number');
  }

  const apiKey = resolveRunLoopApiKey(options.apiKey, options.env);
  const ClientCtor = options.ClientCtor ?? PumpPortalClient;
  const processPumpEvents = options.processPumpEvents ?? (processPumpPortalEvents as ProcessPumpEvents);

  const processExits = options.processExits ?? (processExitsImpl as unknown as ProcessExits);
  const trackOutcomes = options.trackOutcomes ?? (trackCandidateOutcomesImpl as unknown as TrackOutcomes);
  const retryBlockedOpens = options.retryBlockedOpens ?? (retryBlockedOpensImpl as unknown as RetryBlockedOpens);

  let eventsSaved = 0;
  const result: RunBotLoopResult = {
    eventsSaved: 0,
    processRuns: 0,
    eventsRead: 0,
    candidatesEnriched: 0,
    scored: 0,
    openedPositions: 0,
    skipped: 0,
    failed: 0,
    closedPositions: 0,
    retriedPositions: 0,
    outcomesUpdated: 0,
  };

  const client = new ClientCtor({
    apiKey,
    onEvent: (event) => {
      options.store.savePumpPortalEvent(event);
      eventsSaved += 1;
      result.eventsSaved = eventsSaved;
      recordRuntimeStatus({
        status: 'running',
        lastLoopAt: new Date().toISOString(),
        lastIngestAt: event.receivedAt,
        lastError: null,
      });
      options.onLog?.(`[pumpportal] ${event.eventType} mint=${event.tokenMint ?? 'unknown'} symbol=${event.symbol ?? 'unknown'}`);
    },
    onError: (error) => options.onLog?.(`[pumpportal:error] ${error instanceof Error ? error.message : String(error)}`),
    onLog: (message) => options.onLog?.(message),
  });

  let interval: NodeJS.Timeout | undefined;
  let exitOnlyInterval: NodeJS.Timeout | undefined;
  let stopped = false;
  let processInFlight = false;
  let exitInFlight = false;
  let activeProcess: Promise<void> | undefined;
  let activeExit: Promise<void> | undefined;
  // Set when on-chain token activity arrives while a pass is in-flight.
  // Checked at the end of every pass so the exit runs immediately after.
  let activityPendingExit = false;
  // Track the UTC day on which we last pruned so auto-prune fires once per day.
  let lastPrunedDay = '';

  // Token watcher — created only when broker is set (live mode) and a factory
  // is provided. Tracks which mints are currently held so subscriptions stay
  // in sync with open positions after every pass.
  const watchedMints = new Set<string>();
  const tokenWatcher = options.broker && options.createTokenWatcher
    ? options.createTokenWatcher((mint: string) => {
        if (!watchedMints.has(mint)) return; // stale callback after unwatch
        if (processInFlight) {
          activityPendingExit = true;
        } else {
          runExitOnlyPass().catch(logProcessError);
        }
      })
    : undefined;

  // After every pass, add subscriptions for newly opened positions and remove
  // them for positions that have since closed.
  const syncTokenWatcher = () => {
    if (!tokenWatcher || !options.broker) return;
    const currentMints = new Set(options.broker.getOpenPositions().map((p) => p.token.address));
    for (const mint of watchedMints) {
      if (!currentMints.has(mint)) {
        tokenWatcher.unwatch(mint);
        watchedMints.delete(mint);
      }
    }
    for (const mint of currentMints) {
      if (!watchedMints.has(mint)) {
        tokenWatcher.watch(mint);
        watchedMints.add(mint);
      }
    }
  };

  const recordRuntimeStatus = (update: BotRuntimeStatusUpdate) => {
    try {
      options.store.recordBotRuntimeStatus?.(update);
    } catch (error) {
      options.onLog?.(`[run:heartbeat:error] ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const processOnce = async () => {
    if (stopped) return;
    processInFlight = true;
    const processStartedAt = Date.now();
    try {
      const processResult = await processPumpEvents({
        store: options.store,
        solanaConfig: options.solanaConfig,
        paper: options.paper,
        minimumScoreToEnter: options.minimumScoreToEnter,
        strategies: options.strategies,
        limit: options.processLimit,
        maxTradeEventAgeMinutes: options.maxTradeEventAgeMinutes,
        maxPendingAttempts: options.maxPendingAttempts,
        reporter: options.reporter,
        broker: options.broker,
      });
      const processMs = Date.now() - processStartedAt;
      result.processRuns += 1;
      result.eventsRead += processResult.eventsRead;
      result.candidatesEnriched += processResult.candidatesEnriched;
      result.scored += processResult.scored;
      result.openedPositions += processResult.openedPositions;
      result.skipped += processResult.skipped;
      result.failed += processResult.failed;
      const processPassAt = new Date().toISOString();
      recordRuntimeStatus({
        status: 'running',
        lastLoopAt: processPassAt,
        lastProcessPassAt: processPassAt,
        lastError: null,
      });
      options.onLog?.(
        `[run:process] events=${processResult.eventsRead} enriched=${processResult.candidatesEnriched} scored=${processResult.scored} opened=${processResult.openedPositions} skipped=${processResult.skipped} failed=${processResult.failed} ms=${processMs}`,
      );

      // After ingesting/opening, re-price open positions and apply exit rules so
      // positions actually close instead of accumulating until the cap blocks
      // every new entry.
      if (options.exits && canProcessExits(options.store)) {
        const exitResult = await runExitPass('main');

        // If the exit pass freed capacity, try to fill it with recently scored
        // candidates that were blocked when they were first processed.
        if (exitResult && canRetryBlockedOpens(options.store)) {
          const cutoffIso = new Date(Date.now() - options.exits.maxHoldMinutes * 60_000).toISOString();
          const retryResult = await retryBlockedOpens({
            store: options.store,
            paper: options.paper,
            minimumScoreToEnter: options.minimumScoreToEnter,
            strategies: options.strategies,
            cutoffIso,
            refreshCandidate: refreshRetryCandidate,
            broker: options.broker,
          });
          result.openedPositions += retryResult.openedPositions;
          result.retriedPositions += retryResult.openedPositions;
          if (retryResult.openedPositions > 0 || retryResult.skippedRefresh > 0) {
            options.onLog?.(
              `[run:retry] candidates=${retryResult.candidates} opened=${retryResult.openedPositions} skippedRefresh=${retryResult.skippedRefresh} ms=${Date.now() - processStartedAt}`,
            );
          }
        }
      }

      // Capture forward outcomes for recently scored candidates (traded or not)
      // so the score threshold can be tuned from real MFE/MAE data. Horizon
      // matches the trade hold window.
      if (options.exits && canTrackOutcomes(options.store)) {
        const outcomeStartedAt = Date.now();
        const outcomeResult = await trackOutcomes({
          store: options.store,
          horizonMinutes: options.exits.maxHoldMinutes,
          thresholds: { takeProfitPct: options.exits.takeProfitPct, stopLossPct: options.exits.stopLossPct },
        });
        result.outcomesUpdated += outcomeResult.updated;
        options.onLog?.(
          `[run:outcomes] finalized=${outcomeResult.finalized} tracked=${outcomeResult.tracked} updated=${outcomeResult.updated} completed=${outcomeResult.completed} noPrice=${outcomeResult.missingPrice} ms=${Date.now() - outcomeStartedAt}`,
        );
      }

      // Emit a structured cycle summary after every full pass so the reporter
      // can surface cash / open count / trade activity without parsing log lines.
      if (options.reporter?.onCycleSummary) {
        const summaryBroker = options.broker
          ?? (isBrokerStateStore(options.store) ? restoreBrokerFromStore(options.store, options.paper) : undefined);
        if (summaryBroker) {
          options.reporter.onCycleSummary({
            cashUsd: summaryBroker.getCashUsd(),
            openPositions: summaryBroker.getOpenPositions().length,
            closedThisCycle: result.closedPositions,
            openedThisCycle: processResult.openedPositions,
            eventsProcessed: processResult.eventsRead,
          });
        }
      }

      // Periodic analytics summary — emitted every N passes so long-running
      // sessions stay legible without stopping the bot to run `stats`.
      const analyticsInterval = options.analyticsIntervalPasses ?? 0;
      if (analyticsInterval > 0 && result.processRuns % analyticsInterval === 0 && typeof options.store.loadClosedTradeStats === 'function') {
        const stats = options.store.loadClosedTradeStats();
        if (stats.length > 0) {
          const analyticsReport = renderAnalyticsReport(computeTradeAnalytics(stats));
          for (const line of analyticsReport.split('\n')) {
            if (line) options.onLog?.(`[analytics] ${line}`);
          }
        }
      }

      // Auto-prune once per UTC day to keep disk bounded. Fires after the first
      // pass of each new day so it never delays time-sensitive startup paths.
      const todayUtc = new Date().toISOString().slice(0, 10);
      if (options.retention && todayUtc !== lastPrunedDay) {
        const { scoredCandidateDays, pumpPortalEventDays, volumeSnapshotDays } = options.retention;
        const now = Date.now();
        const candidateCutoff = new Date(now - scoredCandidateDays * 864e5).toISOString();
        const eventCutoff = new Date(now - pumpPortalEventDays * 864e5).toISOString();
        const snapshotCutoff = new Date(now - volumeSnapshotDays * 864e5).toISOString();
        const candidates = options.store.pruneScoredCandidates?.(candidateCutoff) ?? 0;
        const events = options.store.prunePumpPortalEvents?.(eventCutoff) ?? 0;
        const snapshots = options.store.pruneTokenVolumeSnapshots?.(snapshotCutoff) ?? 0;
        lastPrunedDay = todayUtc;
        if (candidates + events + snapshots > 0) {
          options.onLog?.(
            `[prune] daily retention pass: candidates=${candidates} events=${events} snapshots=${snapshots}`,
          );
        }
      }

      syncTokenWatcher();
    } finally {
      processInFlight = false;
      // If on-chain activity arrived while this pass was running, fire an
      // exit check immediately rather than waiting for the next interval.
      if (activityPendingExit && !stopped) {
        activityPendingExit = false;
        runExitOnlyPass().catch(logProcessError);
      }
    }
  };

  const startProcessPass = async () => {
    if (processInFlight) {
      // Skip overlapping passes: a long pass + short interval would otherwise
      // fan out duplicate enrichment requests and double-write scored rows.
      options.onLog?.('[run:process] skipped (previous pass still running)');
      return;
    }
    activeProcess = processOnce().finally(() => {
      activeProcess = undefined;
    });
    await activeProcess;
  };

  const runExitPass = async (source: 'main' | 'fast'): Promise<ProcessExitsResult | undefined> => {
    if (!options.exits || !canProcessExits(options.store)) return;
    if (exitInFlight || stopped) return;
    exitInFlight = true;
    const exitStartedAt = Date.now();
    try {
      const exitResult = await processExits({
        store: options.store,
        paper: options.paper,
        exits: options.exits,
        resolveExits: options.resolveExits,
        reporter: options.reporter,
        broker: options.broker,
        onLog: options.onLog,
      });
      result.closedPositions += exitResult.closed;
      const exitPassAt = new Date().toISOString();
      recordRuntimeStatus({
        status: 'running',
        lastLoopAt: exitPassAt,
        lastExitPassAt: exitPassAt,
        lastError: null,
      });
      if (source === 'main' || exitResult.closed > 0 || exitResult.repriced > 0 || exitResult.failed > 0) {
        const prefix = source === 'fast' ? '[run:exits:fast]' : '[run:exits]';
        options.onLog?.(
          `${prefix} checked=${exitResult.positionsChecked} repriced=${exitResult.repriced} closed=${exitResult.closed} sl=${exitResult.stopLoss} tp=${exitResult.takeProfit} trail=${exitResult.trailingStop} timeout=${exitResult.timeout} noPrice=${exitResult.missingPrice} failed=${exitResult.failed} ms=${Date.now() - exitStartedAt}`,
        );
      }
      syncTokenWatcher();
      return exitResult;
    } finally {
      exitInFlight = false;
    }
  };

  // Exit-only pass: evaluates open positions against current prices and fires
  // exit rules without waiting for candidate processing. It has its own guard
  // so a slow enrichment pass cannot delay stop-loss/trailing-stop checks.
  const runExitOnlyPass = async () => {
    activeExit = runExitPass('fast')
      .then(() => undefined)
      .finally(() => {
        activeExit = undefined;
      });
    await activeExit;
  };

  const logProcessError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    recordRuntimeStatus({ status: 'running', lastError: message });
    options.onLog?.(`[run:error] ${message}`);
  };

  options.onLog?.('[run] started');
  recordRuntimeStatus({ status: 'running', lastLoopAt: new Date().toISOString(), lastError: null });
  try {
    await client.connectFreeStreams();
    await startProcessPass();
    await new Promise<void>((resolve) => {
      interval = setInterval(() => {
        startProcessPass().catch(logProcessError);
      }, options.processIntervalMs);

      // Separate, tighter exit interval for live mode. Fires independently of
      // the main process interval so positions are protected on sub-30s timescales.
      if (options.exitIntervalMs && options.exitIntervalMs < options.processIntervalMs) {
        exitOnlyInterval = setInterval(() => {
          runExitOnlyPass().catch(logProcessError);
        }, options.exitIntervalMs);
      }

      let timeout: NodeJS.Timeout | undefined;
      const stop = () => {
        if (timeout) clearTimeout(timeout);
        options.stopSignal?.removeEventListener('abort', stop);
        resolve();
      };

      if (options.durationMs !== undefined) {
        timeout = setTimeout(stop, Math.max(0, options.durationMs));
      }
      if (options.stopSignal) {
        if (options.stopSignal.aborted) {
          stop();
        } else {
          options.stopSignal.addEventListener('abort', stop, { once: true });
        }
      }
    });
  } finally {
    stopped = true;
    recordRuntimeStatus({ status: 'stopping', lastLoopAt: new Date().toISOString() });
    if (interval) clearInterval(interval);
    if (exitOnlyInterval) clearInterval(exitOnlyInterval);
    tokenWatcher?.close();
    if (activeProcess) {
      await activeProcess.catch(logProcessError);
    }
    if (activeExit) {
      await activeExit.catch(logProcessError);
    }
    client.close();
    recordRuntimeStatus({ status: 'stopped', lastLoopAt: new Date().toISOString() });
    options.onLog?.('[run] stopped');
  }

  return result;
}
