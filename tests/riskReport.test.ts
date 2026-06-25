import { describe, expect, it } from 'vitest';
import { computeRiskReport, renderRiskReport, type RiskTradeRow } from '../src/bot/riskReport.js';

function row(overrides: Partial<RiskTradeRow>): RiskTradeRow {
  return {
    id: 1,
    positionId: 'paper-1',
    address: 'mint-1',
    symbol: 'MOCK',
    strategyId: 'freshLaunchMomentum',
    score: 81,
    reason: 'stop_loss',
    pnlUsd: -5,
    pnlPct: -20,
    openedAt: '2026-01-01T00:00:00.000Z',
    closedAt: '2026-01-01T00:05:00.000Z',
    routeInputSymbol: 'USDC',
    liquidityUsd: 50_000,
    volume5mUsd: 10_000,
    priceChange5mPct: 20,
    ageMinutes: 5,
    ...overrides,
  };
}

describe('riskReport', () => {
  it('surfaces duplicate exposure, worst losses, and risk buckets', () => {
    const report = computeRiskReport([
      row({ id: 1, address: 'mint-a', symbol: 'DUP', strategyId: 'freshLaunchMomentum', pnlUsd: -10, pnlPct: -40, routeInputSymbol: 'SOL', ageMinutes: 0, liquidityUsd: 15_000, priceChange5mPct: 120 }),
      row({ id: 2, address: 'mint-a', symbol: 'DUP', strategyId: 'migrationMomentum', pnlUsd: -8, pnlPct: -32, routeInputSymbol: 'SOL', ageMinutes: 0, liquidityUsd: 15_000, priceChange5mPct: 120 }),
      row({ id: 3, address: 'mint-b', symbol: 'WIN', pnlUsd: 12, pnlPct: 48, routeInputSymbol: 'USDC', ageMinutes: 12, liquidityUsd: 75_000, priceChange5mPct: 30, reason: 'trailing_stop' }),
    ]);

    expect(report.trades).toBe(3);
    expect(report.totalPnlUsd).toBeCloseTo(-6);
    expect(report.duplicateExposure).toHaveLength(1);
    expect(report.duplicateExposure[0]).toMatchObject({
      symbol: 'DUP',
      trades: 2,
      pnlUsd: -18,
      strategies: ['freshLaunchMomentum', 'migrationMomentum'],
    });
    expect(report.byRouteInput[0]).toMatchObject({ label: 'SOL', trades: 2, pnlUsd: -18 });
    expect(report.byAgeBucket.find((bucket) => bucket.label === '<3m')?.trades).toBe(2);
    expect(report.byLiquidityBucket.find((bucket) => bucket.label === '<25k')?.trades).toBe(2);
    expect(report.byPriceChangeBucket.find((bucket) => bucket.label === '100%+')?.trades).toBe(2);
    expect(report.worstLosses[0].symbol).toBe('DUP');

    const rendered = renderRiskReport(report);
    expect(rendered).toContain('Risk Driver Report');
    expect(rendered).toContain('Duplicate mint exposure');
    expect(rendered).toContain('Worst losses');
    expect(rendered).toContain('route=SOL');
  });

  it('renders empty history clearly', () => {
    expect(renderRiskReport(computeRiskReport([]))).toBe('No closed trades yet.\n');
  });
});
