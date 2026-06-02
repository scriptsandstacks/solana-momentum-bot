import { describe, expect, it } from 'vitest';
import { computeTuneRecommendations, renderTuneReport } from '../src/bot/tune.js';
import { computeOutcomeAnalytics, type OutcomeRow } from '../src/bot/analytics.js';

const thresholds = { takeProfitPct: 50, stopLossPct: 20 };
const currentEntry = 75;

function outcome(overrides: Partial<OutcomeRow>): OutcomeRow {
  return {
    score: 80,
    recommendation: 'paper_trade',
    scoredPriceUsd: 0.01,
    outcomeHighUsd: 0.015,
    outcomeLowUsd: 0.009,
    outcomeLastUsd: 0.014,
    ...overrides,
  };
}

// Build N copies of an outcome row to satisfy the minimum sample threshold.
function repeat(row: OutcomeRow, n: number): OutcomeRow[] {
  return Array.from({ length: n }, () => ({ ...row }));
}

describe('computeTuneRecommendations', () => {
  it('returns empty recommendations when sample size is below minimum', () => {
    const analytics = computeOutcomeAnalytics([], thresholds);
    const result = computeTuneRecommendations(analytics, thresholds, currentEntry);
    expect(result.sampleSize).toBe(0);
    expect(result.recommendations).toHaveLength(0);
  });

  it('recommends raising entry threshold when above-threshold bucket hits SL > TP', () => {
    // Bucket 75-79 (above threshold 75): lots of stop-loss hits, few TP hits.
    const weakAbove = repeat(
      outcome({
        score: 77,
        outcomeHighUsd: 0.011,  // only +10% MFE — misses 50% TP
        outcomeLowUsd: 0.008,   // -20% MAE — hits SL
        outcomeLastUsd: 0.008,
        outcomeFirstStopLossAt: '2026-01-01T00:10:00Z',
      }),
      15,
    );
    const strongAbove = repeat(
      outcome({ score: 85, outcomeHighUsd: 0.016, outcomeLowUsd: 0.0095, outcomeLastUsd: 0.015, outcomeFirstTakeProfitAt: '2026-01-01T00:05:00Z' }),
      15,
    );
    const analytics = computeOutcomeAnalytics([...weakAbove, ...strongAbove], thresholds);
    const result = computeTuneRecommendations(analytics, thresholds, currentEntry);

    const entryRec = result.recommendations.find((r) => r.parameter === 'scoring.minimumScoreToEnter');
    expect(entryRec).toBeDefined();
    expect(entryRec?.suggestion).toContain('Raise');
  });

  it('recommends raising TP ceiling when avg MFE greatly exceeds takeProfitPct', () => {
    // All candidates go to +150% MFE — 3x the 50% TP ceiling.
    const highMfe = repeat(
      outcome({
        score: 85,
        outcomeHighUsd: 0.025, // +150% from 0.01
        outcomeLowUsd: 0.0095,
        outcomeLastUsd: 0.022,
        outcomeFirstTakeProfitAt: '2026-01-01T00:05:00Z',
      }),
      20,
    );
    const analytics = computeOutcomeAnalytics(highMfe, thresholds);
    const result = computeTuneRecommendations(analytics, thresholds, currentEntry);

    const tpRec = result.recommendations.find((r) => r.parameter === 'exits.takeProfitPct');
    expect(tpRec).toBeDefined();
    expect(tpRec?.confidence).toBe('high');
  });

  it('returns a no-change recommendation when parameters look well calibrated', () => {
    // Mixed results, no obvious outliers — above-threshold bucket wins more than it loses.
    const balanced = repeat(
      outcome({
        score: 82,
        outcomeHighUsd: 0.016, // +60% — hits 50% TP
        outcomeLowUsd: 0.0091, // -9% MAE — does not hit 20% SL
        outcomeLastUsd: 0.015,
        outcomeFirstTakeProfitAt: '2026-01-01T00:08:00Z',
      }),
      25,
    );
    const analytics = computeOutcomeAnalytics(balanced, thresholds);
    const result = computeTuneRecommendations(analytics, thresholds, currentEntry);

    // May emit a stop-loss tightening suggestion (avg MAE well within SL limit)
    // but should NOT recommend raising the entry threshold.
    const entryRec = result.recommendations.find((r) => r.parameter === 'scoring.minimumScoreToEnter' && r.suggestion.includes('Raise'));
    expect(entryRec).toBeUndefined();
  });
});

describe('renderTuneReport', () => {
  it('renders a readable report with bucket table and recommendations', () => {
    const rows = repeat(
      outcome({ score: 85, outcomeHighUsd: 0.025, outcomeLowUsd: 0.0095, outcomeLastUsd: 0.022, outcomeFirstTakeProfitAt: '2026-01-01T00:05:00Z' }),
      20,
    );
    const analytics = computeOutcomeAnalytics(rows, thresholds);
    const result = computeTuneRecommendations(analytics, thresholds, currentEntry);
    const report = renderTuneReport(result, analytics, thresholds, currentEntry);

    expect(report).toContain('Threshold Tuning Recommendations');
    expect(report).toContain('Outcome by score bucket');
    expect(report).toContain('Recommendations');
  });

  it('renders a no-data message when outcome rows are empty', () => {
    const analytics = computeOutcomeAnalytics([], thresholds);
    const result = computeTuneRecommendations(analytics, thresholds, currentEntry);
    const report = renderTuneReport(result, analytics, thresholds, currentEntry);
    expect(report).toContain('Not enough data');
  });
});
