import { describe, expect, it } from 'vitest';
import {
  computeTradeAnalytics,
  renderAnalyticsReport,
  computeOutcomeAnalytics,
  renderOutcomeAnalytics,
  type AnalyticsTrade,
  type OutcomeRow,
} from '../src/bot/analytics.js';

function trade(overrides: Partial<AnalyticsTrade>): AnalyticsTrade {
  return {
    reason: 'take_profit',
    exitPriceSource: 'fresh',
    score: 82,
    source: 'pumpportal+dexscreener',
    pnlUsd: 10,
    pnlPct: 40,
    openedAt: '2026-01-01T00:00:00.000Z',
    closedAt: '2026-01-01T00:10:00.000Z',
    ...overrides,
  };
}

describe('computeTradeAnalytics', () => {
  it('summarizes overall expectancy, win rate, and profit factor', () => {
    const analytics = computeTradeAnalytics([
      trade({ pnlUsd: 30 }),
      trade({ pnlUsd: 10 }),
      trade({ pnlUsd: -20, reason: 'stop_loss' }),
    ]);

    const o = analytics.overall;
    expect(o.trades).toBe(3);
    expect(o.wins).toBe(2);
    expect(o.losses).toBe(1);
    expect(o.winRatePct).toBeCloseTo((2 / 3) * 100);
    expect(o.totalPnlUsd).toBeCloseTo(20);
    expect(o.expectancyUsd).toBeCloseTo(20 / 3);
    expect(o.avgWinUsd).toBeCloseTo(20); // (30 + 10) / 2
    expect(o.avgLossUsd).toBeCloseTo(-20);
    expect(o.profitFactor).toBeCloseTo(40 / 20); // grossWin 40 / grossLoss 20
  });

  it('reports profit factor as Infinity when there are no losses', () => {
    const analytics = computeTradeAnalytics([trade({ pnlUsd: 5 }), trade({ pnlUsd: 7 })]);
    expect(analytics.overall.profitFactor).toBe(Number.POSITIVE_INFINITY);
  });

  it('buckets by reason, score, exit source, and discovery source', () => {
    const analytics = computeTradeAnalytics([
      trade({ reason: 'take_profit', score: 92, exitPriceSource: 'fresh', source: 'raydium', pnlUsd: 30 }),
      trade({ reason: 'stop_loss', score: 76, exitPriceSource: 'fresh', source: 'raydium', pnlUsd: -10 }),
      trade({ reason: 'timeout', score: 88, exitPriceSource: 'last_mark', source: 'dexscreener', pnlUsd: -2 }),
    ]);

    expect(analytics.byReason.map((b) => b.label).sort()).toEqual(['stop_loss', 'take_profit', 'timeout']);
    // Sorted by total PnL desc: the 90-100 winner leads, the 75-79 loser trails.
    expect(analytics.byScoreBucket[0].label).toBe('90-100');
    expect(analytics.byScoreBucket.at(-1)?.label).toBe('75-79');
    expect(analytics.byExitPriceSource.find((b) => b.label === 'last_mark')?.trades).toBe(1);
    expect(analytics.bySource.find((b) => b.label === 'raydium')?.trades).toBe(2);
  });

  it('computes average hold time from open/close timestamps', () => {
    const analytics = computeTradeAnalytics([
      trade({ openedAt: '2026-01-01T00:00:00.000Z', closedAt: '2026-01-01T00:30:00.000Z' }),
      trade({ openedAt: '2026-01-01T00:00:00.000Z', closedAt: '2026-01-01T00:10:00.000Z' }),
    ]);
    expect(analytics.overall.avgHoldMinutes).toBeCloseTo(20); // (30 + 10) / 2
  });

  it('handles an empty trade history without dividing by zero', () => {
    const analytics = computeTradeAnalytics([]);
    expect(analytics.overall.trades).toBe(0);
    expect(analytics.overall.expectancyUsd).toBe(0);
    expect(analytics.overall.winRatePct).toBe(0);
    expect(renderAnalyticsReport(analytics)).toContain('No closed trades yet');
  });
});

function outcome(overrides: Partial<OutcomeRow>): OutcomeRow {
  return {
    score: 80,
    recommendation: 'paper_trade',
    scoredPriceUsd: 0.01,
    outcomeHighUsd: 0.012,
    outcomeLowUsd: 0.009,
    outcomeLastUsd: 0.011,
    ...overrides,
  };
}

describe('computeOutcomeAnalytics', () => {
  const thresholds = { takeProfitPct: 50, stopLossPct: 20 };

  it('computes MFE/MAE and TP/SL hit rates relative to the scored price', () => {
    const analytics = computeOutcomeAnalytics(
      [
        // +60% high (reaches TP), -5% low. final +20%.
        outcome({ scoredPriceUsd: 0.01, outcomeHighUsd: 0.016, outcomeLowUsd: 0.0095, outcomeLastUsd: 0.012 }),
        // +10% high (no TP), -30% low (hits SL). final -25%.
        outcome({ scoredPriceUsd: 0.01, outcomeHighUsd: 0.011, outcomeLowUsd: 0.007, outcomeLastUsd: 0.0075 }),
      ],
      thresholds,
    );

    const o = analytics.overall;
    expect(o.candidates).toBe(2);
    expect(o.avgMfePct).toBeCloseTo((60 + 10) / 2);
    expect(o.avgMaePct).toBeCloseTo((-5 + -30) / 2);
    expect(o.reachedTpRatePct).toBeCloseTo(50); // 1 of 2 reached +50%
    expect(o.hitSlRatePct).toBeCloseTo(50); // 1 of 2 hit -20%
  });

  it('uses first TP/SL crossing timestamps to report path-dependent outcomes', () => {
    const analytics = computeOutcomeAnalytics(
      [
        outcome({
          outcomeHighUsd: 0.016,
          outcomeLowUsd: 0.007,
          outcomeFirstTakeProfitAt: '2026-01-01T00:03:00.000Z',
          outcomeFirstStopLossAt: '2026-01-01T00:05:00.000Z',
        }),
        outcome({
          outcomeHighUsd: 0.016,
          outcomeLowUsd: 0.007,
          outcomeFirstTakeProfitAt: '2026-01-01T00:08:00.000Z',
          outcomeFirstStopLossAt: '2026-01-01T00:04:00.000Z',
        }),
        outcome({ outcomeHighUsd: 0.016, outcomeLowUsd: 0.007 }), // legacy/unknown ordering
      ],
      thresholds,
    );

    expect(analytics.overall.tpFirstRatePct).toBeCloseTo(100 / 3);
    expect(analytics.overall.slFirstRatePct).toBeCloseTo(100 / 3);
    expect(analytics.overall.ambiguousRatePct).toBeCloseTo(100 / 3);
    expect(renderOutcomeAnalytics(analytics, thresholds)).toContain('tpFirst= 33.3% slFirst= 33.3% ambiguous= 33.3%');
  });

  it('buckets outcomes by score and reports an empty state', () => {
    const analytics = computeOutcomeAnalytics(
      [outcome({ score: 92, outcomeHighUsd: 0.02 }), outcome({ score: 77, outcomeHighUsd: 0.0105 })],
      thresholds,
    );
    expect(analytics.byScoreBucket.map((b) => b.label)).toContain('90-100');
    expect(analytics.byScoreBucket.map((b) => b.label)).toContain('75-79');

    const empty = computeOutcomeAnalytics([], thresholds);
    expect(empty.overall.candidates).toBe(0);
    expect(renderOutcomeAnalytics(empty, thresholds)).toContain('No tracked outcomes yet');
  });
});
