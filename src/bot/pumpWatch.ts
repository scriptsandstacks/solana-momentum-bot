import { PumpPortalClient, type PumpPortalRawEvent } from '../discovery/pumpPortal.js';

interface PumpPortalStore {
  savePumpPortalEvent(event: PumpPortalRawEvent): void;
}

type PumpPortalClientLike = {
  connectFreeStreams(): Promise<void>;
  close(): void;
};

type PumpPortalClientCtor = new (options: {
  apiKey: string;
  onEvent?: (event: PumpPortalRawEvent) => void;
  onError?: (error: unknown) => void;
}) => PumpPortalClientLike;

interface RunPumpWatchOptions {
  apiKey?: string;
  durationMs: number;
  store: PumpPortalStore;
  ClientCtor?: PumpPortalClientCtor;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  onLog?: (message: string) => void;
}

export interface PumpWatchResult {
  eventsSaved: number;
}

export function resolvePumpPortalApiKey(
  explicitApiKey?: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const apiKey = explicitApiKey ?? env.PUMPPORTAL_API_KEY;
  if (!apiKey) {
    throw new Error('Missing PumpPortal API key. Set PUMPPORTAL_API_KEY or pass --api-key.');
  }
  return apiKey;
}

export async function runPumpWatch(options: RunPumpWatchOptions): Promise<PumpWatchResult> {
  const apiKey = resolvePumpPortalApiKey(options.apiKey, options.env);
  const ClientCtor = options.ClientCtor ?? PumpPortalClient;
  let eventsSaved = 0;
  const client = new ClientCtor({
    apiKey,
    onEvent: (event) => {
      options.store.savePumpPortalEvent(event);
      eventsSaved += 1;
      options.onLog?.(`[pumpportal] ${event.eventType} mint=${event.tokenMint ?? 'unknown'} symbol=${event.symbol ?? 'unknown'}`);
    },
    onError: (error) => options.onLog?.(`[pumpportal:error] ${error instanceof Error ? error.message : String(error)}`),
  });

  await client.connectFreeStreams();
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, options.durationMs)));
  client.close();
  return { eventsSaved };
}
