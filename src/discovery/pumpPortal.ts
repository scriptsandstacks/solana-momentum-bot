import WebSocket from 'ws';

export type PumpPortalEventType = 'new_token' | 'migration' | 'unknown';

export interface PumpPortalRawEvent {
  source: 'pumpportal';
  eventType: PumpPortalEventType;
  tokenMint?: string;
  symbol?: string;
  name?: string;
  signature?: string;
  raw: unknown;
  receivedAt: string;
}

type WebSocketLike = {
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (error: unknown) => void;
  onclose?: () => void;
  send(message: string): void;
  close(): void;
};

type WebSocketCtor = new (url: string) => WebSocketLike;

interface PumpPortalClientOptions {
  apiKey: string;
  WebSocketCtor?: WebSocketCtor;
  onEvent?: (event: PumpPortalRawEvent) => void;
  onError?: (error: unknown) => void;
  onLog?: (message: string) => void;
  /** Delay schedule (ms) for reconnect attempts. Last entry repeats forever. */
  reconnectDelaysMs?: number[];
  /** Disable reconnect (used in tests that assert single-connect behavior). */
  reconnect?: boolean;
  setTimeoutFn?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
}

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export function buildPumpPortalUrl(apiKey: string): string {
  return `wss://pumpportal.fun/api/data?api-key=${encodeURIComponent(apiKey)}`;
}

export function normalizePumpPortalEvent(raw: any): PumpPortalRawEvent {
  const txType = String(raw?.txType ?? raw?.type ?? '').toLowerCase();
  const eventType: PumpPortalEventType = txType === 'create' ? 'new_token' : txType === 'migrate' ? 'migration' : 'unknown';
  return {
    source: 'pumpportal',
    eventType,
    tokenMint: raw?.mint,
    symbol: raw?.symbol,
    name: raw?.name,
    signature: raw?.signature,
    raw,
    receivedAt: new Date().toISOString(),
  };
}

export class PumpPortalClient {
  private readonly apiKey: string;
  private readonly WebSocketCtor: WebSocketCtor;
  private readonly onEvent?: (event: PumpPortalRawEvent) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly onLog?: (message: string) => void;
  private readonly reconnectDelaysMs: number[];
  private readonly reconnectEnabled: boolean;
  private readonly setTimeoutFn: (handler: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimeoutFn: (handle: NodeJS.Timeout) => void;
  private socket?: WebSocketLike;
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(options: PumpPortalClientOptions) {
    this.apiKey = options.apiKey;
    this.WebSocketCtor = options.WebSocketCtor ?? (WebSocket as unknown as WebSocketCtor);
    this.onEvent = options.onEvent;
    this.onError = options.onError;
    this.onLog = options.onLog;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.reconnectEnabled = options.reconnect ?? true;
    this.setTimeoutFn = options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  }

  async connectFreeStreams(): Promise<void> {
    if (this.socket) return;
    this.closed = false;
    await this.openSocket();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
  }

  private openSocket(): Promise<void> {
    const socket = new this.WebSocketCtor(buildPumpPortalUrl(this.apiKey));
    this.socket = socket;

    socket.onmessage = (message) => {
      try {
        const raw = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
        const normalized = normalizePumpPortalEvent(raw);
        if (normalized.eventType !== 'unknown') this.onEvent?.(normalized);
      } catch (error) {
        this.onError?.(error);
      }
    };
    socket.onerror = (error) => this.onError?.(error);
    socket.onclose = () => {
      // Clear our reference so a stale handle can't be reused, then schedule a
      // reconnect unless the caller asked us to stop. Reconnect ensures the
      // long-running `run` command does not silently stall on a dropped socket.
      this.socket = undefined;
      if (!this.closed && this.reconnectEnabled) this.scheduleReconnect();
    };

    return new Promise<void>((resolve) => {
      socket.onopen = () => {
        this.reconnectAttempts = 0;
        socket.send(JSON.stringify({ method: 'subscribeNewToken' }));
        socket.send(JSON.stringify({ method: 'subscribeMigration' }));
        resolve();
      };
    });
  }

  private scheduleReconnect(): void {
    const delayIndex = Math.min(this.reconnectAttempts, this.reconnectDelaysMs.length - 1);
    const delayMs = this.reconnectDelaysMs[delayIndex];
    this.reconnectAttempts += 1;
    this.onLog?.(`[pumpportal] socket closed; reconnect attempt ${this.reconnectAttempts} in ${delayMs}ms`);
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = undefined;
      if (this.closed) return;
      this.openSocket().catch((error) => {
        this.onError?.(error);
        if (!this.closed && this.reconnectEnabled) this.scheduleReconnect();
      });
    }, delayMs);
  }
}
