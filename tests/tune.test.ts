import { describe, expect, it } from 'vitest';
import {
  applyTuneConfigUpdates,
  computeStrategyTuneRecommendations,
  computeTuneRecommendations,
  deriveTuneConfigUpdates,
  renderStrategyTuneReport,
  renderTuneApplyPreview,
  renderTuneReport,
} from '../src/bot/tune.js';
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

  it('flags volume-acceleration buckets that underperform', () => {
    const overheated = repeat(
      outcome({
        score: 82,
        volumeAcceleration5mZ: 2.5,
        outcomeHighUsd: 0.011,
        outcomeLowUsd: 0.007,
        outcomeLastUsd: 0.008,
        outcomeFirstStopLossAt: '2026-01-01T00:03:00Z',
      }),
      15,
    );
    const analytics = computeOutcomeAnalytics(overheated, thresholds);
    const result = computeTuneRecommendations(analytics, thresholds, currentEntry);

    const rec = result.recommendations.find((r) => r.parameter === 'risk.volumeAcceleration5mZ');
    expect(rec?.suggestion).toContain('Review volume-acceleration boost');
  });

  it('flags holder-concentration buckets that contradict current risk assumptions', () => {
    const concentratedWinners = repeat(
      outcome({
        score: 82,
        top5HolderPct: 85,
        outcomeHighUsd: 0.018,
        outcomeLowUsd: 0.009,
        outcomeLastUsd: 0.015,
        outcomeFirstTakeProfitAt: '2026-01-01T00:04:00Z',
      }),
      15,
    );
    const analytics = computeOutcomeAnalytics(concentratedWinners, thresholds);
    const result = computeTuneRecommendations(analytics, thresholds, currentEntry);

    const rec = result.recommendations.find((r) => r.parameter === 'risk.top5HolderPct');
    expect(rec?.suggestion).toContain('Review holder-concentration penalty');
    expect(deriveTuneConfigUpdates([rec!])).toHaveLength(0);
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

describe('strategy-specific tune recommendations', () => {
  it('uses each strategy threshold when computing strategy-level recommendations', () => {
    const rows = [
      ...repeat(
        outcome({
          strategyId: 'freshLaunchMomentum',
          score: 77,
          outcomeHighUsd: 0.011,
          outcomeLowUsd: 0.008,
          outcomeLastUsd: 0.008,
          outcomeFirstStopLossAt: '2026-01-01T00:10:00Z',
        }),
        15,
      ),
      ...repeat(
        outcome({
          strategyId: 'migrationMomentum',
          score: 72,
          outcomeHighUsd: 0.011,
          outcomeLowUsd: 0.008,
          outcomeLastUsd: 0.008,
          outcomeFirstStopLossAt: '2026-01-01T00:10:00Z',
        }),
        15,
      ),
    ];

    const results = computeStrategyTuneRecommendations(rows, thresholds, {
      freshLaunchMomentum: 75,
      migrationMomentum: 70,
    });

    const fresh = results.find((result) => result.strategyId === 'freshLaunchMomentum');
    const migration = results.find((result) => result.strategyId === 'migrationMomentum');
    expect(fresh?.currentEntryThreshold).toBe(75);
    expect(migration?.currentEntryThreshold).toBe(70);
    expect(fresh?.result.recommendations[0]?.parameter).toBe('strategies.freshLaunchMomentum.minScoreToEnter');
    expect(migration?.result.recommendations[0]?.parameter).toBe('strategies.migrationMomentum.minScoreToEnter');
    expect(fresh?.result.recommendations[0]?.suggestion).toBe('Raise to 80');
    expect(migration?.result.recommendations[0]?.suggestion).toBe('Raise to 75');

    const report = renderStrategyTuneReport(results, thresholds);
    expect(report).toContain('Strategy-specific tuning');
    expect(report).toContain('Strategy: freshLaunchMomentum');
    expect(report).toContain('Strategy: migrationMomentum');
  });
});

describe('tune config updates', () => {
  it('derives concrete numeric updates and skips ambiguous suggestions', () => {
    const updates = deriveTuneConfigUpdates([
      {
        parameter: 'scoring.minimumScoreToEnter',
        currentValue: 75,
        suggestion: 'Raise to 80',
        rationale: 'test',
        confidence: 'high',
      },
      {
        parameter: 'exits.stopLossPct',
        currentValue: 20,
        suggestion: 'Consider tightening to 15%',
        rationale: 'test',
        confidence: 'medium',
      },
      {
        parameter: 'exits.takeProfitPct',
        currentValue: 50,
        suggestion: 'Raise to 200-300 and rely on trailing stop instead',
        rationale: 'test',
        confidence: 'high',
      },
      {
        parameter: 'general',
        currentValue: '',
        suggestion: 'No changes recommended',
        rationale: 'test',
        confidence: 'low',
      },
    ]);

    expect(updates).toHaveLength(2);
    expect(updates.map((u) => ({ path: u.path.join('.'), value: u.value }))).toEqual([
      { path: 'scoring.minimumScoreToEnter', value: 80 },
      { path: 'exits.stopLossPct', value: 15 },
    ]);
  });

  it('applies tune updates to YAML while leaving other config intact', () => {
    const configText = [
      'mode: paper',
      'exits:',
      '  stopLossPct: 20',
      '  takeProfitPct: 300',
      'scoring:',
      '  minimumScoreToEnter: 75',
      '',
    ].join('\n');
    const updates = deriveTuneConfigUpdates([
      {
        parameter: 'scoring.minimumScoreToEnter',
        currentValue: 75,
        suggestion: 'Consider lowering to 70',
        rationale: 'test',
        confidence: 'low',
      },
      {
        parameter: 'exits.stopLossPct',
        currentValue: 20,
        suggestion: 'Consider tightening to 15%',
        rationale: 'test',
        confidence: 'medium',
      },
    ]);

    const updated = applyTuneConfigUpdates(configText, updates);

    expect(updated).toContain('minimumScoreToEnter: 70');
    expect(updated).toContain('stopLossPct: 15');
    expect(updated).toContain('takeProfitPct: 300');
    expect(renderTuneApplyPreview(updates)).toContain('scoring.minimumScoreToEnter = 70');
  });

  it('derives and applies strategy-specific tune updates', () => {
    const configText = [
      'mode: paper',
      'strategies:',
      '  freshLaunchMomentum:',
      '    minScoreToEnter: 75',
      '  migrationMomentum:',
      '    minScoreToEnter: 70',
      'scoring:',
      '  minimumScoreToEnter: 75',
      '',
    ].join('\n');
    const updates = deriveTuneConfigUpdates([
      {
        parameter: 'strategies.migrationMomentum.minScoreToEnter',
        currentValue: 70,
        suggestion: 'Raise to 75',
        rationale: 'test',
        confidence: 'medium',
      },
    ]);

    const updated = applyTuneConfigUpdates(configText, updates);

    expect(updates.map((u) => ({ path: u.path.join('.'), value: u.value }))).toEqual([
      { path: 'strategies.migrationMomentum.minScoreToEnter', value: 75 },
    ]);
    expect(updated).toContain('migrationMomentum:\n    minScoreToEnter: 75');
  });
});
