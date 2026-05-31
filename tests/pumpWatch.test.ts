import { describe, expect, it } from 'vitest';
import { resolvePumpPortalApiKey, runPumpWatch } from '../src/bot/pumpWatch.js';
import type { PumpPortalRawEvent } from '../src/discovery/pumpPortal.js';

describe('pumpWatch', () => {
  it('resolves API key from provided value or environment', () => {
    expect(resolvePumpPortalApiKey('explicit', {})).toBe('explicit');
    expect(resolvePumpPortalApiKey(undefined, { PUMPPORTAL_API_KEY: 'from-env' })).toBe('from-env');
    expect(() => resolvePumpPortalApiKey(undefined, {})).toThrow(/PUMPPORTAL_API_KEY/);
  });

  it('stores incoming free-stream events and stops after bounded duration', async () => {
    const saved: PumpPortalRawEvent[] = [];
    class FakeClient {
      constructor(private readonly options: { onEvent?: (event: PumpPortalRawEvent) => void }) {}
      async connectFreeStreams() {
        this.options.onEvent?.({
          source: 'pumpportal',
          eventType: 'new_token',
          tokenMint: 'mint-1',
          symbol: 'MPUMP',
          raw: { txType: 'create' },
          receivedAt: '2026-01-01T00:00:00Z',
        });
      }
      close() {}
    }

    const result = await runPumpWatch({
      apiKey: 'abc123',
      durationMs: 5,
      store: { savePumpPortalEvent: (event) => saved.push(event) },
      ClientCtor: FakeClient,
    });

    expect(result.eventsSaved).toBe(1);
    expect(saved[0]).toMatchObject({ eventType: 'new_token', tokenMint: 'mint-1' });
  });
});
