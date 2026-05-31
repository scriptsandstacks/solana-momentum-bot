import { describe, expect, it } from 'vitest';
import { buildPumpPortalUrl, normalizePumpPortalEvent, PumpPortalClient } from '../src/discovery/pumpPortal.js';

describe('PumpPortal helpers', () => {
  it('builds websocket URL with API key from env/config', () => {
    expect(buildPumpPortalUrl('abc123')).toBe('wss://pumpportal.fun/api/data?api-key=abc123');
  });

  it('normalizes new-token events into raw event records', () => {
    const event = normalizePumpPortalEvent({
      txType: 'create',
      mint: 'mint-1',
      name: 'Mock Pump',
      symbol: 'MPUMP',
      traderPublicKey: 'creator-1',
      signature: 'sig-1',
      bondingCurveKey: 'curve-1',
    });

    expect(event).toMatchObject({
      source: 'pumpportal',
      eventType: 'new_token',
      tokenMint: 'mint-1',
      symbol: 'MPUMP',
      name: 'Mock Pump',
      signature: 'sig-1',
    });
  });

  it('normalizes migration events into raw event records', () => {
    const event = normalizePumpPortalEvent({
      txType: 'migrate',
      mint: 'mint-2',
      pool: 'pool-1',
      signature: 'sig-2',
    });

    expect(event).toMatchObject({
      source: 'pumpportal',
      eventType: 'migration',
      tokenMint: 'mint-2',
      signature: 'sig-2',
    });
  });
});

describe('PumpPortalClient', () => {
  it('subscribes to only free streams over one websocket', async () => {
    const sent: string[] = [];
    const client = new PumpPortalClient({
      apiKey: 'abc123',
      WebSocketCtor: class FakeWebSocket {
        static instances = 0;
        onopen: (() => void) | undefined;
        constructor(public readonly url: string) {
          FakeWebSocket.instances += 1;
          setTimeout(() => this.onopen?.(), 0);
        }
        send(message: string) {
          sent.push(message);
        }
        close() {}
      },
    });

    await client.connectFreeStreams();

    expect(sent.map((message) => JSON.parse(message))).toEqual([
      { method: 'subscribeNewToken' },
      { method: 'subscribeMigration' },
    ]);
  });

  it('reconnects after the socket closes and re-sends subscribe messages', async () => {
    const sent: string[] = [];
    const closes: number[] = [];
    const sockets: ReconnFakeSocket[] = [];

    class ReconnFakeSocket {
      onopen: (() => void) | undefined;
      onclose: (() => void) | undefined;
      onmessage: ((event: { data: unknown }) => void) | undefined;
      onerror: ((error: unknown) => void) | undefined;
      constructor(public readonly url: string) {
        sockets.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      send(message: string) {
        sent.push(message);
      }
      close() {
        closes.push(sockets.indexOf(this));
        queueMicrotask(() => this.onclose?.());
      }
    }

    const scheduled: Array<{ delay: number; handler: () => void }> = [];
    const client = new PumpPortalClient({
      apiKey: 'abc123',
      WebSocketCtor: ReconnFakeSocket,
      reconnectDelaysMs: [10, 20],
      setTimeoutFn: (handler, ms) => {
        scheduled.push({ delay: ms, handler });
        return scheduled.length as unknown as NodeJS.Timeout;
      },
      clearTimeoutFn: () => undefined,
    });

    await client.connectFreeStreams();
    expect(sockets).toHaveLength(1);

    // Simulate an unexpected disconnect from the server.
    sockets[0].onclose?.();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delay).toBe(10);

    // Fire the reconnect timer; a new socket should open and re-subscribe.
    scheduled[0].handler();
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    expect(sockets).toHaveLength(2);
    expect(sent.filter((m) => m.includes('subscribeNewToken'))).toHaveLength(2);
    expect(sent.filter((m) => m.includes('subscribeMigration'))).toHaveLength(2);
  });

  it('does not reconnect after an explicit close()', async () => {
    const scheduled: Array<{ delay: number; handler: () => void }> = [];
    class FakeSocket {
      onopen: (() => void) | undefined;
      onclose: (() => void) | undefined;
      constructor() {
        queueMicrotask(() => this.onopen?.());
      }
      send() {}
      close() {
        queueMicrotask(() => this.onclose?.());
      }
    }

    const client = new PumpPortalClient({
      apiKey: 'abc123',
      WebSocketCtor: FakeSocket,
      setTimeoutFn: (handler, ms) => {
        scheduled.push({ delay: ms, handler });
        return scheduled.length as unknown as NodeJS.Timeout;
      },
      clearTimeoutFn: () => undefined,
    });

    await client.connectFreeStreams();
    client.close();
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    expect(scheduled).toHaveLength(0);
  });
});
