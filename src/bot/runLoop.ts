import { PumpPortalClient, type PumpPortalRawEvent } from '../discovery/pumpPortal.js';
import { processPumpPortalEvents, type PumpProcessResult } from './pumpProcess.js';
import { processExits as processExitsImpl, type ExitRules, type ProcessExitsResult } from './exitPositions.js';
import { trackCandidateOutcomes as trackCandidateOutcomesImpl, type TrackOutcomesResult } from './trackOutcomes.js';
import { retryBlockedOpens as retryBlockedOpensImpl, canRetryBlockedOpens, type RetryBlockedOpensResult } from './retryBlockedOpens.js';
import { computeTradeAnalytics, renderAnalyticsReport } from './analytics.js';
import { isBrokerStateStore, restoreBrokerFromStore } from '../paper/restoreBroker.js';
import type { Reporter } from './reporter.js';
import type { TradingStrategy } from '../strategies/types.js';
import type { ChainConfig } from '../config/schema.js';
import type { PaperBrokerOptions } from '../paper/paperBroker.js';
import type { OpportunityScore, PaperPosition, PaperTrade, TokenCandidate } from '../types/domain.js';
import type { ScoredOutcomeUpdate, TrackableScoredCandidateRow, RetriableScoredCandidateRow, ClosedTradeStatRow } from '../storage/sqliteStore.js';

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
}

type ProcessExits = (options: {
  store: RunLoopStore;
  paper: PaperBrokerOptions;
  exits: ExitRules;
  resolveExits?: (strategyId: string | undefined) => ExitRules | undefined;
  reporter?: Reporter;
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
}) => Promise<RetryBlockedOpensResult>;

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
  reporter?: Reporter;
}) => Promise<PumpProcessResult>;

interface RunBotLoopOptions {
  apiKey?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  durationMs?: number;
  processIntervalMs: number;
  processLimit: number;
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
  ClientCtor?: PumpPortalClientCtor;
  processPumpEvents?: ProcessPumpEvents;
  processExits?: ProcessExits;
  trackOutcomes?: TrackOutcomes;
  retryBlockedOpens?: RetryBlockedOpens;
  stopSignal?: AbortSignal;
  onLog?: (message: string) => void;
  reporter?: Reporter;
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
      options.onLog?.(`[pumpportal] ${event.eventType} mint=${event.tokenMint ?? 'unknown'} symbol=${event.symbol ?? 'unknown'}`);
    },
    onError: (error) => options.onLog?.(`[pumpportal:error] ${error instanceof Error ? error.message : String(error)}`),
    onLog: (message) => options.onLog?.(message),
  });

  let interval: NodeJS.Timeout | undefined;
  let stopped = false;
  let processInFlight = false;
  let activeProcess: Promise<void> | undefined;

  const processOnce = async () => {
    if (stopped) return;
    processInFlight = true;
    try {
      const processResult = await processPumpEvents({
        store: options.store,
        solanaConfig: options.solanaConfig,
        paper: options.paper,
        minimumScoreToEnter: options.minimumScoreToEnter,
        strategies: options.strategies,
        limit: options.processLimit,
        reporter: options.reporter,
      });
      result.processRuns += 1;
      result.eventsRead += processResult.eventsRead;
      result.candidatesEnriched += processResult.candidatesEnriched;
      result.scored += processResult.scored;
      result.openedPositions += processResult.openedPositions;
      result.skipped += processResult.skipped;
      result.failed += processResult.failed;
      options.onLog?.(
        `[run:process] events=${processResult.eventsRead} enriched=${processResult.candidatesEnriched} scored=${processResult.scored} opened=${processResult.openedPositions} skipped=${processResult.skipped} failed=${processResult.failed}`,
      );

      // After ingesting/opening, re-price open positions and apply exit rules so
      // positions actually close instead of accumulating until the cap blocks
      // every new entry.
      if (options.exits && canProcessExits(options.store)) {
        const exitResult = await processExits({
          store: options.store,
          paper: options.paper,
          exits: options.exits,
          resolveExits: options.resolveExits,
          reporter: options.reporter,
        });
        result.closedPositions += exitResult.closed;
        options.onLog?.(
          `[run:exits] checked=${exitResult.positionsChecked} repriced=${exitResult.repriced} closed=${exitResult.closed} sl=${exitResult.stopLoss} tp=${exitResult.takeProfit} trail=${exitResult.trailingStop} timeout=${exitResult.timeout} noPrice=${exitResult.missingPrice}`,
        );

        // If the exit pass freed capacity, try to fill it with recently scored
        // candidates that were blocked when they were first processed.
        if (canRetryBlockedOpens(options.store)) {
          const cutoffIso = new Date(Date.now() - options.exits.maxHoldMinutes * 60_000).toISOString();
          const retryResult = await retryBlockedOpens({
            store: options.store,
            paper: options.paper,
            minimumScoreToEnter: options.minimumScoreToEnter,
            strategies: options.strategies,
            cutoffIso,
          });
          result.openedPositions += retryResult.openedPositions;
          result.retriedPositions += retryResult.openedPositions;
          if (retryResult.openedPositions > 0) {
            options.onLog?.(`[run:retry] candidates=${retryResult.candidates} opened=${retryResult.openedPositions}`);
          }
        }
      }

      // Capture forward outcomes for recently scored candidates (traded or not)
      // so the score threshold can be tuned from real MFE/MAE data. Horizon
      // matches the trade hold window.
      if (options.exits && canTrackOutcomes(options.store)) {
        const outcomeResult = await trackOutcomes({
          store: options.store,
          horizonMinutes: options.exits.maxHoldMinutes,
          thresholds: { takeProfitPct: options.exits.takeProfitPct, stopLossPct: options.exits.stopLossPct },
        });
        result.outcomesUpdated += outcomeResult.updated;
        options.onLog?.(
          `[run:outcomes] finalized=${outcomeResult.finalized} tracked=${outcomeResult.tracked} updated=${outcomeResult.updated} completed=${outcomeResult.completed} noPrice=${outcomeResult.missingPrice}`,
        );
      }

      // Emit a structured cycle summary after every full pass so the reporter
      // can surface cash / open count / trade activity without parsing log lines.
      if (options.reporter?.onCycleSummary && isBrokerStateStore(options.store)) {
        const broker = restoreBrokerFromStore(options.store, options.paper);
        options.reporter.onCycleSummary({
          cashUsd: broker.getCashUsd(),
          openPositions: broker.getOpenPositions().length,
          closedThisCycle: result.closedPositions,
          openedThisCycle: processResult.openedPositions,
          eventsProcessed: processResult.eventsRead,
        });
      }

      // Periodic analytics summary — emitted every N passes so long-running
      // sessions stay legible without stopping the bot to run `stats`.
      const interval = options.analyticsIntervalPasses ?? 0;
      if (interval > 0 && result.processRuns % interval === 0 && typeof options.store.loadClosedTradeStats === 'function') {
        const stats = options.store.loadClosedTradeStats();
        if (stats.length > 0) {
          const analyticsReport = renderAnalyticsReport(computeTradeAnalytics(stats));
          for (const line of analyticsReport.split('\n')) {
            if (line) options.onLog?.(`[analytics] ${line}`);
          }
        }
      }
    } finally {
      processInFlight = false;
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

  const logProcessError = (error: unknown) => {
    options.onLog?.(`[run:error] ${error instanceof Error ? error.message : String(error)}`);
  };

  options.onLog?.('[run] started');
  try {
    await client.connectFreeStreams();
    await startProcessPass();
    await new Promise<void>((resolve) => {
      interval = setInterval(() => {
        startProcessPass().catch(logProcessError);
      }, options.processIntervalMs);

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
    if (interval) clearInterval(interval);
    if (activeProcess) {
      await activeProcess.catch(logProcessError);
    }
    client.close();
    options.onLog?.('[run] stopped');
  }

  return result;
}
