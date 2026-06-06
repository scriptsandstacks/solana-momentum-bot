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
        entryTxSignature: 'sig-entry-1',
        entryNetworkFeeUsd: 0.002,
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
        exitPriceSource: 'fresh',
        pnlUsd: 12.5,
        pnlPct: 50,
        openedAt: '2026-01-01T00:00:00Z',
        closedAt: '2026-01-01T00:05:00Z',
        exitTxSignature: 'sig-exit-1',
        entryNetworkFeeUsd: 0.002,
        exitNetworkFeeUsd: 0.004,
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
    expect(report).toContain('entryTx=sig-entry-1');
    expect(report).toContain('exitTx=sig-exit-1');
    expect(report).toContain('entryFee=$0.0020');
    expect(report).toContain('networkFees=$0.0060');
    expect(report).toContain('PumpPortal events: 1');
    expect(report).toContain('new_token MPUMP mint=mint-1 status=processed note=score=82');
    expect(report).toContain('PnL: $12.50');
  });

  it('annotates scored candidates with sell route status', () => {
    const report = renderStorageReport({
      recentScores: [
        { chain: 'solana', symbol: 'OK', priceUsd: 0.01, liquidityUsd: 50_000, volume5mUsd: 10_000, score: 80, recommendation: 'paper_trade', createdAt: '2026-01-01T00:00:00Z', sellRouteAvailable: 1 },
        { chain: 'solana', symbol: 'TRAP', priceUsd: 0.01, liquidityUsd: 50_000, volume5mUsd: 10_000, score: 20, recommendation: 'ignore', createdAt: '2026-01-01T00:00:00Z', sellRouteAvailable: 0 },
        { chain: 'solana', symbol: 'OLD', priceUsd: 0.01, liquidityUsd: 50_000, volume5mUsd: 10_000, score: 75, recommendation: 'paper_trade', createdAt: '2026-01-01T00:00:00Z' },
      ],
      openPositions: [],
      closedTrades: [],
    });

    expect(report).toContain('OK score=80 rec=paper_trade route=none sell=ok');
    expect(report).toContain('TRAP score=20 rec=ignore route=none sell=NO');
    expect(report).not.toContain('OLD score=75 rec=paper_trade route=none sell=');
  });

  it('renders stale timeout price source for closed trades', () => {
    const report = renderStorageReport({
      recentScores: [],
      openPositions: [],
      closedTrades: [{
        positionId: 'paper-9',
        chain: 'solana',
        symbol: 'STALE',
        reason: 'timeout',
        exitPriceSource: 'last_mark',
        pnlUsd: -2.5,
        pnlPct: -10,
        closedAt: '2026-01-01T01:00:00Z',
      }],
      pumpPortalEvents: [],
    });

    expect(report).toContain('paper-9 SOLANA STALE reason=timeout source=last_mark');
  });
});
