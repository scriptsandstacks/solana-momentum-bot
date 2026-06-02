// Subscribes to Solana RPC log notifications (logsSubscribe) for a set of token
// mints. When a confirmed transaction mentions a watched mint, fires onActivity so
// the run loop can trigger an immediate exit evaluation rather than waiting for the
// next polling interval.
//
// Uses a single WebSocket connection shared across all watched tokens. Reconnects
// automatically with exponential backoff and re-subscribes all active watches.
// Only fires for successful transactions (err: null) — failed transactions do not
// change the AMM price.

import WebSocket from 'ws';

type WsLike = {
  onopen?: (() => void) | null;
  onmessage?: ((event: { data: unknown }) => void) | null;
  onerror?: ((error: unknown) => void) | null;
  onclose?: (() => void) | null;
  send(message: string): void;
  close(): void;
};

type WsCtor = new (url: string) => WsLike;

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

export interface TokenActivityWatcherOptions {
  // Solana RPC WebSocket URL. Typically the rpcUrlEnv value with https:// → wss://
  rpcWsUrl: string;
  // Called when a watched token has on-chain activity (debounced per mint).
  onActivity: (tokenMint: string) => void;
  onError?: (error: Error) => void;
  onLog?: (message: string) => void;
  // Minimum ms between onActivity calls for the same mint. Prevents callback
  // storms during high-volume trading. Default: 1000 ms.
  debounceMs?: number;
  reconnectDelaysMs?: number[];
  // Injectable for testing
  WsCtor?: WsCtor;
  setTimeoutFn?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn?: (handle: NodeJS.Timeout) => void;
}

// Convert an HTTP(S) RPC URL to a WebSocket URL. Most providers (Helius,
// QuickNode, Alchemy) use the same host and path for both HTTP and WebSocket.
export function rpcUrlToWs(rpcUrl: string): string {
  return rpcUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
}

export class TokenActivityWatcher {
  private ws: WsLike | undefined;
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;

  // Mints we should be subscribed to. Source of truth for reconnect re-subscription.
  private readonly watchedMints = new Set<string>();
  // subId → mint (populated when RPC confirms the subscription).
  private readonly subIdToMint = new Map<number, string>();
  // mint → subId (reverse index for unsubscription).
  private readonly mintToSubId = new Map<string, number>();
  // requestId → mint (maps outgoing subscribe requests to their mint).
  private readonly pendingByReqId = new Map<number, string>();
  // mint → debounce timer.
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();

  private nextReqId = 1;

  private readonly debounceMs: number;
  private readonly reconnectDelaysMs: number[];
  private readonly WsCtor: WsCtor;
  private readonly setTimeoutFn: (handler: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimeoutFn: (handle: NodeJS.Timeout) => void;

  constructor(private readonly options: TokenActivityWatcherOptions) {
    this.debounceMs = options.debounceMs ?? 1_000;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
    this.WsCtor = options.WsCtor ?? (WebSocket as unknown as WsCtor);
    this.setTimeoutFn = options.setTimeoutFn ?? ((h, ms) => setTimeout(h, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((h) => clearTimeout(h));
  }

  // Begin watching a token mint. Safe to call multiple times for the same mint.
  watch(tokenMint: string): void {
    if (this.watchedMints.has(tokenMint)) return;
    this.watchedMints.add(tokenMint);
    this.subscribe(tokenMint);
  }

  // Stop watching a token mint. Safe to call for un-watched mints.
  unwatch(tokenMint: string): void {
    if (!this.watchedMints.has(tokenMint)) return;
    this.watchedMints.delete(tokenMint);
    this.unsubscribe(tokenMint);
    const timer = this.debounceTimers.get(tokenMint);
    if (timer) {
      this.clearTimeoutFn(timer);
      this.debounceTimers.delete(tokenMint);
    }
  }

  // Connect to the RPC WebSocket. Called automatically on first watch if not yet
  // connected, but exposed so the caller can pre-connect before the first watch.
  connect(): void {
    if (this.ws || this.closed) return;
    this.openSocket();
  }

  // Permanently close the watcher and the underlying WebSocket.
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    for (const timer of this.debounceTimers.values()) this.clearTimeoutFn(timer);
    this.debounceTimers.clear();
    this.ws?.close();
    this.ws = undefined;
  }

  // ─── private ────────────────────────────────────────────────────────────────

  private openSocket(): void {
    const socket = new this.WsCtor(this.options.rpcWsUrl);
    this.ws = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.options.onLog?.(`[watcher] connected to ${this.options.rpcWsUrl}`);
      // Re-subscribe to all currently watched mints (covers reconnect case).
      for (const mint of this.watchedMints) {
        this.subscribe(mint);
      }
    };

    socket.onmessage = (event) => {
      try {
        const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        this.handleMessage(msg);
      } catch {
        // Malformed JSON — ignore silently.
      }
    };

    socket.onerror = (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.options.onError?.(err);
    };

    socket.onclose = () => {
      this.ws = undefined;
      this.subIdToMint.clear();
      this.mintToSubId.clear();
      this.pendingByReqId.clear();
      if (!this.closed) this.scheduleReconnect();
    };
  }

  private send(message: Record<string, unknown>): void {
    if (!this.ws) this.openSocket();
    try {
      this.ws?.send(JSON.stringify(message));
    } catch {
      // Socket not ready — the subscription will be re-sent on reconnect.
    }
  }

  private subscribe(tokenMint: string): void {
    // Don't subscribe if we already have an active sub for this mint.
    if (this.mintToSubId.has(tokenMint)) return;
    const id = this.nextReqId++;
    this.pendingByReqId.set(id, tokenMint);
    this.send({
      jsonrpc: '2.0',
      id,
      method: 'logsSubscribe',
      params: [{ mentions: [tokenMint] }, { commitment: 'confirmed' }],
    });
  }

  private unsubscribe(tokenMint: string): void {
    const subId = this.mintToSubId.get(tokenMint);
    if (subId === undefined) return;
    this.mintToSubId.delete(tokenMint);
    this.subIdToMint.delete(subId);
    this.send({ jsonrpc: '2.0', id: this.nextReqId++, method: 'logsUnsubscribe', params: [subId] });
  }

  private handleMessage(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return;
    const m = msg as Record<string, unknown>;

    // Subscription confirmation: {"id": N, "result": subId}
    if (typeof m.id === 'number' && typeof m.result === 'number') {
      const mint = this.pendingByReqId.get(m.id);
      this.pendingByReqId.delete(m.id);
      if (mint && this.watchedMints.has(mint)) {
        this.subIdToMint.set(m.result, mint);
        this.mintToSubId.set(mint, m.result);
      }
      return;
    }

    // Log notification: {"method":"logsNotification","params":{"subscription":N,"result":{...}}}
    if (m.method !== 'logsNotification') return;
    const params = m.params as Record<string, unknown> | undefined;
    if (!params) return;
    const subId = params.subscription as number | undefined;
    if (typeof subId !== 'number') return;
    const mint = this.subIdToMint.get(subId);
    if (!mint) return;

    // Skip failed transactions — they don't change the on-chain price.
    const result = params.result as { value?: { err?: unknown } } | undefined;
    if (result?.value?.err != null) return;

    this.fireActivity(mint);
  }

  private fireActivity(tokenMint: string): void {
    // Debounce: cancel any pending timer and reset.
    const existing = this.debounceTimers.get(tokenMint);
    if (existing) this.clearTimeoutFn(existing);

    const timer = this.setTimeoutFn(() => {
      this.debounceTimers.delete(tokenMint);
      if (this.watchedMints.has(tokenMint)) {
        this.options.onActivity(tokenMint);
      }
    }, this.debounceMs);
    this.debounceTimers.set(tokenMint, timer);
  }

  private scheduleReconnect(): void {
    const idx = Math.min(this.reconnectAttempts, this.reconnectDelaysMs.length - 1);
    const delayMs = this.reconnectDelaysMs[idx];
    this.reconnectAttempts += 1;
    this.options.onLog?.(`[watcher] disconnected; reconnect attempt ${this.reconnectAttempts} in ${delayMs}ms`);
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = undefined;
      if (!this.closed) this.openSocket();
    }, delayMs);
  }
}
