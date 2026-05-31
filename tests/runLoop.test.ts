import { describe, expect, it } from 'vitest';
import { runBotLoop, resolveRunLoopApiKey } from '../src/bot/runLoop.js';
import type { PumpPortalRawEvent } from '../src/discovery/pumpPortal.js';

class FakePumpClient {
  static closes = 0;
  constructor(private readonly options: { onEvent?: (event: PumpPortalRawEvent) => void }) {}
  async connectFreeStreams() {
    this.options.onEvent?.({
      source: 'pumpportal',
      eventType: 'new_token',
      tokenMint: 'mint-1',
      symbol: 'PUMP',
      raw: { txType: 'create', mint: 'mint-1' },
      receivedAt: '2026-01-01T00:00:00Z',
    });
  }
  close() {
    FakePumpClient.closes += 1;
  }
}

describe('runBotLoop', () => {
  it('resolves API key from explicit value or environment', () => {
    expect(resolveRunLoopApiKey('explicit', {})).toBe('explicit');
    expect(resolveRunLoopApiKey(undefined, { PUMPPORTAL_API_KEY: 'env-key' })).toBe('env-key');
    expect(() => resolveRunLoopApiKey(undefined, {})).toThrow(/PUMPPORTAL_API_KEY/);
  });

  it('connects PumpPortal once, processes on interval, then closes cleanly', async () => {
    FakePumpClient.closes = 0;
    const saved: PumpPortalRawEvent[] = [];
    const processedLimits: number[] = [];
    const logs: string[] = [];

    const result = await runBotLoop({
      apiKey: 'abc123',
      durationMs: 25,
      processIntervalMs: 10,
      processLimit: 7,
      store: {
        savePumpPortalEvent: (event) => saved.push(event),
      },
      solanaConfig: {
        enabled: true,
        minLiquidityUsd: 10_000,
        minVolume5mUsd: 5_000,
        maxSlippageBps: 500,
      },
      paper: {
        startingBalanceUsd: 1000,
        positionSizeUsd: 25,
        maxOpenPositions: 3,
      },
      minimumScoreToEnter: 75,
      ClientCtor: FakePumpClient,
      processPumpEvents: async ({ limit }) => {
        processedLimits.push(limit ?? 0);
        return { eventsRead: 1, candidatesEnriched: 1, scored: 1, openedPositions: 0, skipped: 0, failed: 0 };
      },
      onLog: (message) => logs.push(message),
    });

    expect(saved).toHaveLength(1);
    expect(processedLimits.length).toBeGreaterThanOrEqual(2);
    expect(processedLimits.every((limit) => limit === 7)).toBe(true);
    expect(FakePumpClient.closes).toBe(1);
    expect(result.eventsSaved).toBe(1);
    expect(result.processRuns).toBe(processedLimits.length);
    expect(result.scored).toBe(processedLimits.length);
    expect(logs.join('\n')).toContain('[run] started');
    expect(logs.join('\n')).toContain('[run] stopped');
  });

  it('runs an exit pass each interval when exit rules and a stateful store are provided', async () => {
    FakePumpClient.closes = 0;
    const exitCalls: number[] = [];

    const result = await runBotLoop({
      apiKey: 'abc123',
      durationMs: 25,
      processIntervalMs: 10,
      processLimit: 5,
      store: {
        savePumpPortalEvent: () => undefined,
        // Stateful store surface so runLoop's isBrokerStateStore guard passes.
        loadOpenPositions: () => [],
        getRealizedPnlUsd: () => 0,
        getRealizedPnlUsdSince: () => 0,
        getNextPositionSeq: () => 1,
        saveClosedTrade: () => undefined,
      },
      solanaConfig: { enabled: true, minLiquidityUsd: 10_000, minVolume5mUsd: 5_000, maxSlippageBps: 500 },
      paper: { startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 3 },
      minimumScoreToEnter: 75,
      exits: { stopLossPct: 20, takeProfitPct: 50, trailingStopPct: 20, maxHoldMinutes: 45 },
      ClientCtor: FakePumpClient,
      processPumpEvents: async () => ({
        eventsRead: 0,
        candidatesEnriched: 0,
        scored: 0,
        openedPositions: 0,
        skipped: 0,
        failed: 0,
      }),
      processExits: async () => {
        exitCalls.push(1);
        return {
          positionsChecked: 1,
          repriced: 1,
          missingPrice: 0,
          closed: 1,
          stopLoss: 0,
          takeProfit: 1,
          trailingStop: 0,
          timeout: 0,
        };
      },
    });

    expect(exitCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.closedPositions).toBe(exitCalls.length);
  });

  it('skips overlapping process passes when the previous pass is still running', async () => {
    FakePumpClient.closes = 0;
    const logs: string[] = [];
    let callCount = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    let releaseSlow: (() => void) | undefined;

    await runBotLoop({
      apiKey: 'abc123',
      durationMs: 60,
      processIntervalMs: 5,
      processLimit: 10,
      store: { savePumpPortalEvent: () => undefined },
      solanaConfig: {
        enabled: true,
        minLiquidityUsd: 10_000,
        minVolume5mUsd: 5_000,
        maxSlippageBps: 500,
      },
      paper: { startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 3 },
      minimumScoreToEnter: 75,
      ClientCtor: FakePumpClient,
      processPumpEvents: async () => {
        callCount += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        // Block the second pass to force a subsequent interval tick to overlap
        // — that next tick should be skipped by the inFlight guard.
        if (callCount === 2) {
          await new Promise<void>((resolve) => {
            releaseSlow = resolve;
          });
        }
        concurrent -= 1;
        return { eventsRead: 0, candidatesEnriched: 0, scored: 0, openedPositions: 0, skipped: 0, failed: 0 };
      },
      onLog: (message) => {
        logs.push(message);
        if (message.includes('skipped (previous pass still running)') && releaseSlow) {
          releaseSlow();
          releaseSlow = undefined;
        }
      },
    });

    expect(maxConcurrent).toBe(1);
    expect(logs.some((m) => m.includes('skipped (previous pass still running)'))).toBe(true);
  });

  it('terminates cleanly when stopSignal aborts mid-run', async () => {
    FakePumpClient.closes = 0;
    const stopController = new AbortController();
    const logs: string[] = [];

    const promise = runBotLoop({
      apiKey: 'abc123',
      processIntervalMs: 50,
      processLimit: 5,
      store: { savePumpPortalEvent: () => undefined },
      solanaConfig: {
        enabled: true,
        minLiquidityUsd: 10_000,
        minVolume5mUsd: 5_000,
        maxSlippageBps: 500,
      },
      paper: { startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 3 },
      minimumScoreToEnter: 75,
      ClientCtor: FakePumpClient,
      processPumpEvents: async () => ({
        eventsRead: 0,
        candidatesEnriched: 0,
        scored: 0,
        openedPositions: 0,
        skipped: 0,
        failed: 0,
      }),
      stopSignal: stopController.signal,
      onLog: (m) => logs.push(m),
    });

    // Give the loop a brief moment to enter the wait, then abort.
    await new Promise((resolve) => setTimeout(resolve, 20));
    stopController.abort();

    const result = await promise;
    expect(FakePumpClient.closes).toBe(1);
    expect(result.processRuns).toBeGreaterThanOrEqual(1);
    expect(logs.at(-1)).toBe('[run] stopped');
  });
});
