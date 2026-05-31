import { describe, expect, it } from 'vitest';
import { processPumpPortalEvents } from '../src/bot/pumpProcess.js';
import type { OpportunityScore, PaperPosition, TokenCandidate } from '../src/types/domain.js';

function strongCandidate(address: string): TokenCandidate {
  return {
    chain: 'solana',
    address,
    symbol: 'PUMP',
    name: 'Pump Token',
    pairAddress: 'pair-1',
    priceUsd: 0.01,
    liquidityUsd: 75_000,
    volume5mUsd: 30_000,
    volume1hUsd: 150_000,
    priceChange5mPct: 12,
    buys5m: 90,
    sells5m: 30,
    ageMinutes: 12,
    source: 'pumpportal+dexscreener',
    routeAvailable: false,
    estimatedSlippageBps: 10_000,
  };
}

describe('processPumpPortalEvents', () => {
  it('enriches pending PumpPortal events, scores them, and opens paper positions', async () => {
    const scored: Array<{ candidate: TokenCandidate; score: OpportunityScore }> = [];
    const opened: PaperPosition[] = [];
    const statuses: Array<{ id: number; status: string; note?: string }> = [];

    const result = await processPumpPortalEvents({
      store: {
        listPendingPumpPortalEvents: () => [
          {
            id: 1,
            eventType: 'new_token',
            tokenMint: 'mint-1',
            symbol: 'PUMP',
            rawJson: '{}',
            receivedAt: '2026-01-01T00:00:00Z',
          },
        ],
        markPumpPortalEventProcessed: (id, status, note) => statuses.push({ id, status, note }),
        saveScoredCandidate: (candidate, score) => scored.push({ candidate, score }),
        saveOpenPosition: (position) => opened.push(position),
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
      fetchCandidates: async () => [strongCandidate('mint-1')],
      checkRoute: async () => ({
        routeAvailable: true,
        estimatedSlippageBps: 100,
        routeInputMint: 'usdc-mint',
        routeInputSymbol: 'USDC',
      }),
    });

    expect(result).toMatchObject({ eventsRead: 1, candidatesEnriched: 1, scored: 1, openedPositions: 1 });
    expect(scored[0].candidate).toMatchObject({
      address: 'mint-1',
      source: 'pumpportal+dexscreener+new_token',
      routeAvailable: true,
      routeInputSymbol: 'USDC',
    });
    expect(scored[0].score.recommendation).toBe('paper_trade');
    expect(opened).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ id: 1, status: 'processed' });
  });

  it('marks events skipped when market data is not available yet', async () => {
    const statuses: Array<{ id: number; status: string; note?: string }> = [];

    const result = await processPumpPortalEvents({
      store: {
        listPendingPumpPortalEvents: () => [
          {
            id: 7,
            eventType: 'new_token',
            tokenMint: 'fresh-mint',
            rawJson: '{}',
            receivedAt: '2026-01-01T00:00:00Z',
          },
        ],
        markPumpPortalEventProcessed: (id, status, note) => statuses.push({ id, status, note }),
        saveScoredCandidate: () => undefined,
        saveOpenPosition: () => undefined,
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
      fetchCandidates: async () => [],
    });

    expect(result).toMatchObject({ eventsRead: 1, scored: 0, skipped: 1 });
    expect(statuses[0]).toMatchObject({ id: 7, status: 'pending', note: 'no DexScreener market data yet' });
  });

  it('marks events skipped after the retry cap is reached', async () => {
    const statuses: Array<{ id: number; status: string; note?: string }> = [];

    const result = await processPumpPortalEvents({
      store: {
        listPendingPumpPortalEvents: () => [
          {
            id: 9,
            eventType: 'new_token',
            tokenMint: 'orphan-mint',
            rawJson: '{}',
            receivedAt: '2026-01-01T00:00:00Z',
            processingAttempts: 5,
          },
        ],
        markPumpPortalEventProcessed: (id, status, note) => statuses.push({ id, status, note }),
        saveScoredCandidate: () => undefined,
        saveOpenPosition: () => undefined,
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
      maxPendingAttempts: 5,
      fetchCandidates: async () => [],
    });

    expect(result).toMatchObject({ eventsRead: 1, scored: 0, skipped: 1 });
    expect(statuses[0]).toMatchObject({
      id: 9,
      status: 'skipped',
      note: 'max retries reached (5) with no market data',
    });
  });

  it('marks events failed when the Jupiter route check throws', async () => {
    const statuses: Array<{ id: number; status: string; note?: string }> = [];

    const result = await processPumpPortalEvents({
      store: {
        listPendingPumpPortalEvents: () => [
          {
            id: 11,
            eventType: 'new_token',
            tokenMint: 'mint-1',
            symbol: 'PUMP',
            rawJson: '{}',
            receivedAt: '2026-01-01T00:00:00Z',
          },
        ],
        markPumpPortalEventProcessed: (id, status, note) => statuses.push({ id, status, note }),
        saveScoredCandidate: () => undefined,
        saveOpenPosition: () => undefined,
      },
      solanaConfig: {
        enabled: true,
        minLiquidityUsd: 10_000,
        minVolume5mUsd: 5_000,
        maxSlippageBps: 500,
      },
      paper: { startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 3 },
      minimumScoreToEnter: 75,
      fetchCandidates: async () => [strongCandidate('mint-1')],
      checkRoute: async () => {
        throw new Error('jupiter down');
      },
    });

    expect(result).toMatchObject({ eventsRead: 1, failed: 1, scored: 0, openedPositions: 0 });
    expect(statuses[0]).toMatchObject({ id: 11, status: 'failed', note: 'jupiter down' });
  });
});
