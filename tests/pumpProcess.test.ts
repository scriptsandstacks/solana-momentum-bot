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
        confirmationCommitment: 'confirmed',
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
        sellRouteAvailable: true,
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
    expect(scored[0].candidate.strategyId).toBe('freshLaunchMomentum');
    expect(opened).toHaveLength(1);
    expect(opened[0].token.strategyId).toBe('freshLaunchMomentum');
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
        confirmationCommitment: 'confirmed',
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
        confirmationCommitment: 'confirmed',
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

  it('attaches mint/freeze authority flags to the scored candidate when checkAuthority is provided', async () => {
    const scored: Array<{ candidate: TokenCandidate; score: OpportunityScore }> = [];

    await processPumpPortalEvents({
      store: {
        listPendingPumpPortalEvents: () => [
          { id: 20, eventType: 'new_token', tokenMint: 'mint-safe', rawJson: '{}', receivedAt: '2026-01-01T00:00:00Z' },
        ],
        markPumpPortalEventProcessed: () => undefined,
        saveScoredCandidate: (c, s) => scored.push({ candidate: c, score: s }),
        saveOpenPosition: () => undefined,
      },
      solanaConfig: { enabled: true, minLiquidityUsd: 10_000, minVolume5mUsd: 5_000, maxSlippageBps: 500, confirmationCommitment: 'confirmed' },
      paper: { startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 3 },
      minimumScoreToEnter: 75,
      fetchCandidates: async () => [strongCandidate('mint-safe')],
      checkRoute: async () => ({ routeAvailable: true, estimatedSlippageBps: 100, routeInputMint: 'u', routeInputSymbol: 'USDC', sellRouteAvailable: true }),
      checkAuthority: async () => ({ mintAuthorityRevoked: true, freezeAuthorityRevoked: true }),
    });

    expect(scored[0].candidate.mintAuthorityRevoked).toBe(true);
    expect(scored[0].candidate.freezeAuthorityRevoked).toBe(true);
    // Safe flags add bonus points — score should be higher than without the check.
    expect(scored[0].score.reasons).toContain('mint_authority_revoked');
    expect(scored[0].score.reasons).toContain('freeze_authority_revoked');
  });

  it('penalizes score when mint authority is still held', async () => {
    const scored: Array<{ candidate: TokenCandidate; score: OpportunityScore }> = [];

    await processPumpPortalEvents({
      store: {
        listPendingPumpPortalEvents: () => [
          { id: 21, eventType: 'new_token', tokenMint: 'mint-risky', rawJson: '{}', receivedAt: '2026-01-01T00:00:00Z' },
        ],
        markPumpPortalEventProcessed: () => undefined,
        saveScoredCandidate: (c, s) => scored.push({ candidate: c, score: s }),
        saveOpenPosition: () => undefined,
      },
      solanaConfig: { enabled: true, minLiquidityUsd: 10_000, minVolume5mUsd: 5_000, maxSlippageBps: 500, confirmationCommitment: 'confirmed' },
      paper: { startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 3 },
      minimumScoreToEnter: 75,
      fetchCandidates: async () => [strongCandidate('mint-risky')],
      checkRoute: async () => ({ routeAvailable: true, estimatedSlippageBps: 100, routeInputMint: 'u', routeInputSymbol: 'USDC', sellRouteAvailable: true }),
      checkAuthority: async () => ({ mintAuthorityRevoked: false, freezeAuthorityRevoked: false }),
    });

    expect(scored[0].candidate.mintAuthorityRevoked).toBe(false);
    expect(scored[0].score.risks).toContain('mint_authority_held');
    expect(scored[0].score.risks).toContain('freeze_authority_held');
  });

  it('attaches and scores holder concentration when checkHolderConcentration is provided', async () => {
    const scored: Array<{ candidate: TokenCandidate; score: OpportunityScore }> = [];

    await processPumpPortalEvents({
      store: {
        listPendingPumpPortalEvents: () => [
          { id: 22, eventType: 'new_token', tokenMint: 'mint-concentrated', rawJson: '{}', receivedAt: '2026-01-01T00:00:00Z' },
        ],
        markPumpPortalEventProcessed: () => undefined,
        saveScoredCandidate: (c, s) => scored.push({ candidate: c, score: s }),
        saveOpenPosition: () => undefined,
      },
      solanaConfig: { enabled: true, minLiquidityUsd: 10_000, minVolume5mUsd: 5_000, maxSlippageBps: 500, confirmationCommitment: 'confirmed' },
      paper: { startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 3 },
      minimumScoreToEnter: 75,
      fetchCandidates: async () => [strongCandidate('mint-concentrated')],
      checkRoute: async () => ({ routeAvailable: true, estimatedSlippageBps: 100, routeInputMint: 'u', routeInputSymbol: 'USDC', sellRouteAvailable: true }),
      checkAuthority: null,
      checkHolderConcentration: async () => ({ top5HolderPct: 85 }),
    });

    expect(scored[0].candidate.top5HolderPct).toBe(85);
    expect(scored[0].score.risks).toContain('holder_concentration_high');
  });

  it('attaches volume acceleration from recent store snapshots before scoring', async () => {
    const scored: Array<{ candidate: TokenCandidate; score: OpportunityScore }> = [];

    await processPumpPortalEvents({
      store: {
        listPendingPumpPortalEvents: () => [
          { id: 23, eventType: 'new_token', tokenMint: 'mint-accelerating', rawJson: '{}', receivedAt: '2026-01-01T00:00:00Z' },
        ],
        markPumpPortalEventProcessed: () => undefined,
        saveScoredCandidate: (c, s) => scored.push({ candidate: c, score: s }),
        saveOpenPosition: () => undefined,
        listRecentTokenVolumeSnapshots: () => [
          {
            chain: 'solana',
            address: 'mint-accelerating',
            symbol: 'MOCK',
            strategyId: 'freshLaunchMomentum',
            volume5mUsd: 10_000,
            volume1hUsd: 100_000,
            priceUsd: 0.01,
            observedAt: '2026-01-01T00:00:00Z',
          },
          {
            chain: 'solana',
            address: 'mint-accelerating',
            symbol: 'MOCK',
            strategyId: 'freshLaunchMomentum',
            volume5mUsd: 11_000,
            volume1hUsd: 100_000,
            priceUsd: 0.01,
            observedAt: '2026-01-01T00:01:00Z',
          },
          {
            chain: 'solana',
            address: 'mint-accelerating',
            symbol: 'MOCK',
            strategyId: 'freshLaunchMomentum',
            volume5mUsd: 12_000,
            volume1hUsd: 100_000,
            priceUsd: 0.01,
            observedAt: '2026-01-01T00:02:00Z',
          },
        ],
      },
      solanaConfig: { enabled: true, minLiquidityUsd: 10_000, minVolume5mUsd: 5_000, maxSlippageBps: 500, confirmationCommitment: 'confirmed' },
      paper: { startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 3 },
      minimumScoreToEnter: 75,
      fetchCandidates: async () => [strongCandidate('mint-accelerating')],
      checkRoute: async () => ({ routeAvailable: true, estimatedSlippageBps: 100, routeInputMint: 'u', routeInputSymbol: 'USDC', sellRouteAvailable: true }),
      checkAuthority: null,
      checkHolderConcentration: null,
    });

    expect(scored[0].candidate.volumeAccelerationSamples).toBe(3);
    expect(scored[0].candidate.volumeAcceleration5mZ).toBeGreaterThan(2);
    expect(scored[0].score.reasons).toContain('volume_acceleration');
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
        confirmationCommitment: 'confirmed',
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
