import { describe, expect, it } from 'vitest';
import { renderStorageReport } from '../src/bot/storageReport.js';

describe('renderStorageReport', () => {
  it('renders recent scores, positions, and trades from storage rows', () => {
    const report = renderStorageReport({
      recentScores: [
        {
          chain: 'solana',
          address: 'token-1',
          symbol: 'MOCK',
          name: 'Mock Token',
          pairAddress: 'pair-1',
          priceUsd: 0.01,
          liquidityUsd: 50_000,
          volume5mUsd: 15_000,
          routeInputSymbol: 'USDC',
          score: 82,
          recommendation: 'paper_trade',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      openPositions: [{
        id: 'paper-1',
        chain: 'solana',
        address: 'token-1',
        symbol: 'MOCK',
        entryPriceUsd: 0.01,
        quantity: 2500,
        score: 82,
        openedAt: '2026-01-01T00:00:00Z',
      }],
      closedTrades: [{
        positionId: 'paper-0',
        chain: 'solana',
        address: 'token-0',
        symbol: 'WIN',
        entryPriceUsd: 0.01,
        exitPriceUsd: 0.015,
        quantity: 2500,
        reason: 'take_profit',
        pnlUsd: 12.5,
        pnlPct: 50,
        openedAt: '2026-01-01T00:00:00Z',
        closedAt: '2026-01-01T00:05:00Z',
      }],
      pumpPortalEvents: [{
        id: 1,
        eventType: 'new_token',
        tokenMint: 'mint-1',
        symbol: 'MPUMP',
        name: 'Mock Pump',
        signature: 'sig-1',
        rawJson: '{}',
        receivedAt: '2026-01-01T00:10:00Z',
        processingStatus: 'processed',
        processingNote: 'score=82',
      }],
    });

    expect(report).toContain('Recent scores: 1');
    expect(report).toContain('MOCK score=82');
    expect(report).toContain('route=USDC');
    expect(report).toContain('Open positions: 1');
    expect(report).toContain('Closed trades: 1');
    expect(report).toContain('PumpPortal events: 1');
    expect(report).toContain('new_token MPUMP mint=mint-1 status=processed note=score=82');
    expect(report).toContain('PnL: $12.50');
  });
});
