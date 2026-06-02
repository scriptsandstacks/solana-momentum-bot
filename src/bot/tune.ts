// Threshold tuning: translate raw MFE/MAE outcome data into actionable
// recommendations for the score entry threshold and exit parameters.
//
// The underlying data is collected by trackCandidateOutcomes — for every scored
// candidate (whether traded or not), we record the forward high, low, and last
// price over the trade horizon. That gives us MFE, MAE, and whether the
// candidate hit take-profit or stop-loss.
//
// A well-calibrated system should show:
//   - Candidates below the entry threshold hitting TP less often than SL
//     (i.e. the threshold correctly filters out weak signals).
//   - Candidates above the threshold hitting TP more often than SL with
//     positive expectancy after fees.
//   - MFE significantly exceeding the take-profit threshold in the best buckets,
//     indicating the TP ceiling (if fixed) is leaving money on the table.

import type { OutcomeAnalytics, OutcomeBucket, OutcomeThresholds } from './analytics.js';

export interface TuningRecommendation {
  parameter: string;
  currentValue: string | number;
  suggestion: string;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface TuneResult {
  sampleSize: number;
  recommendations: TuningRecommendation[];
}

// Minimum candidate count in a bucket before we trust its statistics.
const MIN_BUCKET_SAMPLE = 10;

export function computeTuneRecommendations(
  analytics: OutcomeAnalytics,
  thresholds: OutcomeThresholds,
  currentEntryThreshold: number,
): TuneResult {
  const recommendations: TuningRecommendation[] = [];
  const total = analytics.overall.candidates;

  if (total < MIN_BUCKET_SAMPLE) {
    return { sampleSize: total, recommendations: [] };
  }

  // --- Entry threshold ---
  // Find the lowest score bucket that has positive expectancy (more TP hits than SL).
  // If the current threshold includes buckets that lose more often than they win,
  // recommend raising it.
  const belowThresholdBuckets = analytics.byScoreBucket.filter(
    (b) => b.label !== 'unknown' && extractMaxScore(b.label) < currentEntryThreshold,
  );
  const aboveThresholdBuckets = analytics.byScoreBucket.filter(
    (b) => b.label !== 'unknown' && extractMinScore(b.label) >= currentEntryThreshold,
  );

  // The worst above-threshold bucket: if it hits SL more than TP and has enough data,
  // the threshold should be raised.
  const weakAbove = aboveThresholdBuckets
    .filter((b) => b.candidates >= MIN_BUCKET_SAMPLE)
    .find((b) => b.hitSlRatePct > b.reachedTpRatePct);

  if (weakAbove) {
    recommendations.push({
      parameter: 'scoring.minimumScoreToEnter',
      currentValue: currentEntryThreshold,
      suggestion: `Raise to ${extractMaxScore(weakAbove.label) + 1}`,
      rationale: `Score bucket ${weakAbove.label} (n=${weakAbove.candidates}) hits stop-loss more often than take-profit (SL=${weakAbove.hitSlRatePct.toFixed(0)}% vs TP=${weakAbove.reachedTpRatePct.toFixed(0)}%). Filtering this bucket out would improve expected win rate.`,
      confidence: weakAbove.candidates >= 20 ? 'high' : 'medium',
    });
  }

  // The best below-threshold bucket: if it hits TP more than SL and has enough data,
  // the threshold may be too conservative.
  const strongBelow = [...belowThresholdBuckets]
    .filter((b) => b.candidates >= MIN_BUCKET_SAMPLE)
    .sort((a, b) => b.reachedTpRatePct - a.reachedTpRatePct)[0];

  if (strongBelow && strongBelow.reachedTpRatePct > strongBelow.hitSlRatePct) {
    recommendations.push({
      parameter: 'scoring.minimumScoreToEnter',
      currentValue: currentEntryThreshold,
      suggestion: `Consider lowering to ${extractMinScore(strongBelow.label)}`,
      rationale: `Score bucket ${strongBelow.label} (n=${strongBelow.candidates}) shows positive edge — TP hit rate ${strongBelow.reachedTpRatePct.toFixed(0)}% vs SL ${strongBelow.hitSlRatePct.toFixed(0)}%. You may be filtering out profitable trades.`,
      confidence: 'low', // conservative — lowering thresholds needs more data
    });
  }

  // --- Take-profit ceiling ---
  // If avgMFE in the best score bucket greatly exceeds the current TP, the fixed
  // ceiling is cutting winners short. (Only relevant when takeProfitPct < 200,
  // as our new default is 300 — a safety ceiling, not a real exit.)
  if (thresholds.takeProfitPct < 150) {
    const topBucket = analytics.byScoreBucket
      .filter((b) => b.candidates >= MIN_BUCKET_SAMPLE)
      .sort((a, b) => b.avgMfePct - a.avgMfePct)[0];

    if (topBucket && topBucket.avgMfePct > thresholds.takeProfitPct * 1.5) {
      recommendations.push({
        parameter: 'exits.takeProfitPct',
        currentValue: thresholds.takeProfitPct,
        suggestion: `Raise to 200–300 and rely on trailing stop instead`,
        rationale: `Top bucket ${topBucket.label} shows avg MFE of +${topBucket.avgMfePct.toFixed(0)}% — ${(topBucket.avgMfePct / thresholds.takeProfitPct).toFixed(1)}x your TP ceiling. A fixed TP at ${thresholds.takeProfitPct}% is systematically cutting winners short on assets with this volatility.`,
        confidence: 'high',
      });
    }
  }

  // --- Stop-loss ---
  // If avgMAE across all traded candidates is much smaller than the current SL,
  // we may be giving too much room on losers.
  if (analytics.overall.candidates >= MIN_BUCKET_SAMPLE * 2) {
    const avgMae = analytics.overall.avgMaePct;
    if (avgMae > -(thresholds.stopLossPct * 0.4)) {
      // Most losers turn negative well before hitting the SL — stop could be tighter.
      recommendations.push({
        parameter: 'exits.stopLossPct',
        currentValue: thresholds.stopLossPct,
        suggestion: `Consider tightening to ${Math.round(thresholds.stopLossPct * 0.75)}%`,
        rationale: `Average MAE is ${avgMae.toFixed(1)}% — much smaller than your ${thresholds.stopLossPct}% stop. Most losing positions are stopped at a fraction of the limit, suggesting you could tighten the stop without missing many saves, and reduce losses when a position immediately goes wrong.`,
        confidence: 'medium',
      });
    }
  }

  // --- No data for a meaningful recommendation ---
  if (recommendations.length === 0 && total >= MIN_BUCKET_SAMPLE) {
    recommendations.push({
      parameter: 'general',
      currentValue: '',
      suggestion: 'No changes recommended',
      rationale: `Based on ${total} tracked outcomes, current parameters appear reasonably calibrated. Continue accumulating data (aim for 50+ per score bucket) for higher-confidence recommendations.`,
      confidence: 'low',
    });
  }

  return { sampleSize: total, recommendations };
}

export function renderTuneReport(
  result: TuneResult,
  analytics: OutcomeAnalytics,
  thresholds: OutcomeThresholds,
  currentEntryThreshold: number,
): string {
  const lines = [
    'Threshold Tuning Recommendations',
    `Based on ${result.sampleSize} tracked candidates`,
    `Current: entry≥${currentEntryThreshold}  SL=${thresholds.stopLossPct}%  TP=${thresholds.takeProfitPct}%`,
    '',
    'Outcome by score bucket:',
    `  ${'Bucket'.padEnd(10)} ${'n'.padStart(5)}  ${'avgMFE'.padStart(8)}  ${'avgMAE'.padStart(8)}  ${'hitTP%'.padStart(7)}  ${'hitSL%'.padStart(7)}`,
  ];

  for (const bucket of analytics.byScoreBucket) {
    const marker = extractMinScore(bucket.label) >= currentEntryThreshold ? '▶' : ' ';
    lines.push(
      `${marker} ${bucket.label.padEnd(10)} ${String(bucket.candidates).padStart(5)}` +
        `  ${('+' + bucket.avgMfePct.toFixed(1) + '%').padStart(8)}` +
        `  ${(bucket.avgMaePct.toFixed(1) + '%').padStart(8)}` +
        `  ${(bucket.reachedTpRatePct.toFixed(0) + '%').padStart(7)}` +
        `  ${(bucket.hitSlRatePct.toFixed(0) + '%').padStart(7)}`,
    );
  }

  if (result.recommendations.length === 0) {
    lines.push('', `Not enough data yet (need ≥${MIN_BUCKET_SAMPLE} candidates per bucket).`);
    return `${lines.join('\n')}\n`;
  }

  lines.push('', 'Recommendations:');
  for (const rec of result.recommendations) {
    lines.push(
      `  [${rec.confidence.toUpperCase()}] ${rec.parameter}`,
      `    Current: ${rec.currentValue}`,
      `    Suggest: ${rec.suggestion}`,
      `    Why:     ${rec.rationale}`,
      '',
    );
  }

  return `${lines.join('\n')}\n`;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function extractMinScore(label: string): number {
  if (label === '<75') return 0;
  const match = /^(\d+)/.exec(label);
  return match ? Number(match[1]) : 0;
}

function extractMaxScore(label: string): number {
  if (label === '<75') return 74;
  const match = /-(\d+)$/.exec(label);
  if (match) return Number(match[1]);
  const single = /^(\d+)$/.exec(label);
  return single ? Number(single[1]) : 100;
}
