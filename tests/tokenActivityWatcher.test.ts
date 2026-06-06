import { describe, expect, it, vi } from 'vitest';
import { TokenActivityWatcher, rpcUrlToWs } from '../src/execution/tokenActivityWatcher.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

type WsHandler = {
  onopen?: (() => void) | null;
  onmessage?: ((event: { data: unknown }) => void) | null;
  onerror?: ((error: unknown) => void) | null;
  onclose?: (() => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

// Fake WebSocket constructor. Captures the last created instance so tests can
// interact with it after construction.
function makeFakeWsCtor(): { Ctor: new (url: string) => WsHandler; instances: WsHandler[] } {
  const instances: WsHandler[] = [];
  const Ctor = class FakeWs {
    onopen?: (() => void) | null;
    onmessage?: ((event: { data: unknown }) => void) | null;
    onerror?: ((error: unknown) => void) | null;
    onclose?: (() => void) | null;
    send = vi.fn();
    close = vi.fn();
    constructor(_url: string) {
      instances.push(this as unknown as WsHandler);
    }
  };
  return { Ctor: Ctor as unknown as new (url: string) => WsHandler, instances };
}

// Deliver a logsSubscribe confirmation to the watcher.
function sendSubscriptionConfirm(ws: WsHandler, reqId: number, subId: number): void {
  ws.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: reqId, result: subId }) });
}

// Deliver a logsNotification for a given subscription ID.
function sendLogNotification(ws: WsHandler, subId: number, err: unknown = null): void {
  ws.onmessage?.({
    data: JSON.stringify({
      jsonrpc: '2.0',
      method: 'logsNotification',
      params: {
        subscription: subId,
        result: {
          context: { slot: 12345 },
          value: {
            signature: 'sig-abc',
            err,
            logs: ['Program log: some instruction'],
          },
        },
      },
    }),
  });
}

function makeSyncTimers(): {
  setTimeoutFn: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearTimeoutFn: (handle: NodeJS.Timeout) => void;
  flushAll: () => void;
} {
  const pending = new Map<NodeJS.Timeout, () => void>();
  let nextId = 1;

  const setTimeoutFn = (handler: () => void, _ms: number): NodeJS.Timeout => {
    const id = nextId++ as unknown as NodeJS.Timeout;
    pending.set(id, handler);
    return id;
  };

  const clearTimeoutFn = (handle: NodeJS.Timeout): void => {
    pending.delete(handle);
  };

  const flushAll = (): void => {
    const handlers = [...pending.values()];
    pending.clear();
    for (const h of handlers) h();
  };

  return { setTimeoutFn, clearTimeoutFn, flushAll };
}

// ─── rpcUrlToWs ──────────────────────────────────────────────────────────────

describe('rpcUrlToWs', () => {
  it('converts https to wss', () => {
    expect(rpcUrlToWs('https://mainnet.helius-rpc.com/?api-key=abc')).toBe(
      'wss://mainnet.helius-rpc.com/?api-key=abc',
    );
  });
  it('converts http to ws', () => {
    expect(rpcUrlToWs('http://localhost:8899')).toBe('ws://localhost:8899');
  });
  it('leaves wss unchanged', () => {
    expect(rpcUrlToWs('wss://already-ws.example.com')).toBe('wss://already-ws.example.com');
  });
});

// ─── TokenActivityWatcher ────────────────────────────────────────────────────

describe('TokenActivityWatcher', () => {
  function make(onActivity = vi.fn()) {
    const { Ctor: WsCtor, instances } = makeFakeWsCtor();
    const timers = makeSyncTimers();
    const watcher = new TokenActivityWatcher({
      rpcWsUrl: 'wss://rpc.example.com',
      onActivity,
      debounceMs: 100,
      WsCtor: WsCtor as any,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    return { watcher, instances, timers, onActivity };
  }

  it('opens a WebSocket on connect()', () => {
    const { watcher, instances } = make();
    watcher.connect();
    expect(instances).toHaveLength(1);
    watcher.close();
  });

  it('sends logsSubscribe on watch() after connect', () => {
    const { watcher, instances } = make();
    watcher.connect();
    const ws = instances[0];
    ws.onopen?.();

    watcher.watch('mint-abc');
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('logsSubscribe'));
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('mint-abc'));
    watcher.close();
  });

  it('fires onActivity after debounce when a confirmed transaction arrives', () => {
    const onActivity = vi.fn();
    const { watcher, instances, timers } = make(onActivity);
    watcher.connect();
    const ws = instances[0];
    ws.onopen?.();

    watcher.watch('mint-abc');
    // The subscribe message has id=1
    sendSubscriptionConfirm(ws, 1, 42);
    sendLogNotification(ws, 42);

    // Before debounce fires — no callback yet
    expect(onActivity).not.toHaveBeenCalled();

    timers.flushAll();
    expect(onActivity).toHaveBeenCalledWith('mint-abc');
    watcher.close();
  });

  it('does not fire onActivity for failed transactions', () => {
    const onActivity = vi.fn();
    const { watcher, instances, timers } = make(onActivity);
    watcher.connect();
    const ws = instances[0];
    ws.onopen?.();

    watcher.watch('mint-abc');
    sendSubscriptionConfirm(ws, 1, 42);
    sendLogNotification(ws, 42, { InstructionError: [0, 'Custom'] }); // err != null

    timers.flushAll();
    expect(onActivity).not.toHaveBeenCalled();
    watcher.close();
  });

  it('debounces rapid notifications: only one callback per debounce window', () => {
    const onActivity = vi.fn();
    const { watcher, instances, timers } = make(onActivity);
    watcher.connect();
    const ws = instances[0];
    ws.onopen?.();

    watcher.watch('mint-abc');
    sendSubscriptionConfirm(ws, 1, 42);

    // Fire 5 notifications quickly — each resets the debounce timer.
    for (let i = 0; i < 5; i++) sendLogNotification(ws, 42);

    timers.flushAll();
    // Only one callback despite 5 notifications.
    expect(onActivity).toHaveBeenCalledTimes(1);
    watcher.close();
  });

  it('sends logsUnsubscribe on unwatch()', () => {
    const { watcher, instances } = make();
    watcher.connect();
    const ws = instances[0];
    ws.onopen?.();

    watcher.watch('mint-abc');
    sendSubscriptionConfirm(ws, 1, 42);
    watcher.unwatch('mint-abc');

    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('logsUnsubscribe'));
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('42'));
    watcher.close();
  });

  it('does not fire onActivity after unwatch()', () => {
    const onActivity = vi.fn();
    const { watcher, instances, timers } = make(onActivity);
    watcher.connect();
    const ws = instances[0];
    ws.onopen?.();

    watcher.watch('mint-abc');
    sendSubscriptionConfirm(ws, 1, 42);
    watcher.unwatch('mint-abc');
    sendLogNotification(ws, 42);

    timers.flushAll();
    expect(onActivity).not.toHaveBeenCalled();
    watcher.close();
  });

  it('re-subscribes to all watched mints on reconnect', () => {
    const { watcher, instances, timers } = make();
    watcher.connect();
    const ws1 = instances[0];
    ws1.onopen?.();

    watcher.watch('mint-abc');
    watcher.watch('mint-xyz');
    expect(ws1.send).toHaveBeenCalledTimes(2); // two subscribe messages

    // Simulate disconnect and reconnect
    ws1.onclose?.();
    timers.flushAll(); // flush reconnect delay
    const ws2 = instances[1];
    ws2.onopen?.();

    // Both mints re-subscribed on the new socket
    const calls = ws2.send.mock.calls.map((c) => c[0] as string);
    expect(calls.some((c) => c.includes('mint-abc'))).toBe(true);
    expect(calls.some((c) => c.includes('mint-xyz'))).toBe(true);
    watcher.close();
  });

  it('does not reconnect after close()', () => {
    const { watcher, instances, timers } = make();
    watcher.connect();
    const ws = instances[0];
    ws.onopen?.();

    watcher.close();
    ws.onclose?.(); // close fires after .close() is called
    timers.flushAll();
    expect(instances).toHaveLength(1); // no second WebSocket created
  });

  it('ignores duplicate watch() calls', () => {
    const { watcher, instances } = make();
    watcher.connect();
    const ws = instances[0];
    ws.onopen?.();

    watcher.watch('mint-abc');
    watcher.watch('mint-abc'); // duplicate
    // Only one subscribe message sent
    const subscribeCalls = ws.send.mock.calls.filter((c) => (c[0] as string).includes('logsSubscribe'));
    expect(subscribeCalls).toHaveLength(1);
    watcher.close();
  });
});

// ─── runLoop integration ──────────────────────────────────────────────────────

describe('runBotLoop token watcher integration', () => {
  it('passes open position mints to the token watcher after each pass', async () => {
    const { runBotLoop } = await import('../src/bot/runLoop.js');
    const { PaperBroker } = await import('../src/paper/paperBroker.js');

    // Broker with one open position
    const broker = new PaperBroker({ startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 3 });
    await broker.openPosition(
      {
        chain: 'solana', address: 'mint-live', symbol: 'LIVE', name: 'Live Token',
        pairAddress: 'pair-1', priceUsd: 0.01, liquidityUsd: 50_000, volume5mUsd: 20_000,
        volume1hUsd: 100_000, priceChange5mPct: 10, buys5m: 80, sells5m: 20, ageMinutes: 5,
        source: 'test', routeAvailable: true, estimatedSlippageBps: 100,
      },
      80,
    );

    const watchedMints: string[] = [];
    const unwatchedMints: string[] = [];

    await runBotLoop({
      apiKey: 'key',
      durationMs: 20,
      processIntervalMs: 15,
      processLimit: 5,
      store: { savePumpPortalEvent: () => {} },
      solanaConfig: { enabled: true, minLiquidityUsd: 10_000, minVolume5mUsd: 5_000, maxSlippageBps: 500, confirmationCommitment: 'confirmed' },
      paper: { startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 3 },
      minimumScoreToEnter: 75,
      ClientCtor: class {
        async connectFreeStreams() {}
        close() {}
      } as any,
      processPumpEvents: async () => ({ eventsRead: 0, candidatesEnriched: 0, scored: 0, openedPositions: 0, skipped: 0, failed: 0 }),
      broker,
      createTokenWatcher: (onActivity) => {
        void onActivity; // captured but not fired in this test
        return {
          watch: (m) => watchedMints.push(m),
          unwatch: (m) => unwatchedMints.push(m),
          close: () => {},
        };
      },
      onLog: () => {},
    });

    expect(watchedMints).toContain('mint-live');
  });
});
