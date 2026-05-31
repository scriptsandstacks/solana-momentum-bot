import { PumpPortalClient, type PumpPortalRawEvent } from '../discovery/pumpPortal.js';
import { processPumpPortalEvents, type PumpProcessResult } from './pumpProcess.js';
import type { ChainConfig } from '../config/schema.js';
import type { OpportunityScore, PaperPosition, TokenCandidate } from '../types/domain.js';

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
  paper: {
    startingBalanceUsd: number;
    positionSizeUsd: number;
    maxOpenPositions: number;
  };
  minimumScoreToEnter: number;
  limit?: number;
}) => Promise<PumpProcessResult>;

interface RunBotLoopOptions {
  apiKey?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  durationMs?: number;
  processIntervalMs: number;
  processLimit: number;
  store: RunLoopStore;
  solanaConfig: ChainConfig;
  paper: {
    startingBalanceUsd: number;
    positionSizeUsd: number;
    maxOpenPositions: number;
  };
  minimumScoreToEnter: number;
  ClientCtor?: PumpPortalClientCtor;
  processPumpEvents?: ProcessPumpEvents;
  stopSignal?: AbortSignal;
  onLog?: (message: string) => void;
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

  const processOnce = async () => {
    if (stopped) return;
    if (processInFlight) {
      // Skip overlapping passes: a long pass + short interval would otherwise
      // fan out duplicate enrichment requests and double-write scored rows.
      options.onLog?.('[run:process] skipped (previous pass still running)');
      return;
    }
    processInFlight = true;
    try {
      const processResult = await processPumpEvents({
        store: options.store,
        solanaConfig: options.solanaConfig,
        paper: options.paper,
        minimumScoreToEnter: options.minimumScoreToEnter,
        limit: options.processLimit,
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
    } finally {
      processInFlight = false;
    }
  };

  options.onLog?.('[run] started');
  try {
    await client.connectFreeStreams();
    await processOnce();
    await new Promise<void>((resolve) => {
      interval = setInterval(() => {
        processOnce().catch((error: unknown) =>
          options.onLog?.(`[run:error] ${error instanceof Error ? error.message : String(error)}`),
        );
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
    client.close();
    options.onLog?.('[run] stopped');
  }

  return result;
}
