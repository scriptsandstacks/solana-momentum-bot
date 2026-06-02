// Performance analytics over closed paper trades. Pure and self-contained so
// the aggregation is unit-testable without a database or network. The point is
// to make paper results legible: expectancy and win/loss shape, broken down by
// the levers we can actually tune (exit rules, score threshold, discovery
// source) and by exit-price provenance so stale-timeout PnL is visible.

export interface AnalyticsTrade {
  reason: string;
  exitPriceSource: string;
  score: number;
  source: string;
  strategyId: string;
  pnlUsd: number;
  pnlPct: number;
  openedAt: string;
  closedAt: string;
}

export interface AnalyticsBucket {
  label: string;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  totalPnlUsd: number;
  // Mean PnL per trade — the expectancy. The single number that says whether
  // this bucket makes money on average after costs.
  expectancyUsd: number;
  avgPnlPct: number;
  avgWinUsd: number;
  avgLossUsd: number;
  // Gross wins / gross losses. > 1 is profitable; a common quant health metric
  // that is robust to a few outsized trades. Infinity when there are no losses.
  profitFactor: number;
  avgHoldMinutes: number;
}

export interface TradeAnalytics {
  overall: AnalyticsBucket;
  byReason: AnalyticsBucket[];
  byExitPriceSource: AnalyticsBucket[];
  byScoreBucket: AnalyticsBucket[];
  bySource: AnalyticsBucket[];
  byStrategy: AnalyticsBucket[];
}

const SCORE_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: '<75', min: Number.NEGATIVE_INFINITY, max: 74 },
  { label: '75-79', min: 75, max: 79 },
  { label: '80-89', min: 80, max: 89 },
  { label: '90-100', min: 90, max: 100 },
];

function holdMinutes(trade: AnalyticsTrade): number {
  const ms = new Date(trade.closedAt).getTime() - new Date(trade.openedAt).getTime();
  return Number.isFinite(ms) ? ms / 60_000 : 0;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(label: string, trades: AnalyticsTrade[]): AnalyticsBucket {
  const wins = trades.filter((trade) => trade.pnlUsd > 0);
  const losses = trades.filter((trade) => trade.pnlUsd < 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnlUsd, 0));
  const totalPnlUsd = trades.reduce((sum, trade) => sum + trade.pnlUsd, 0);

  return {
    label,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length === 0 ? 0 : (wins.length / trades.length) * 100,
    totalPnlUsd,
    expectancyUsd: trades.length === 0 ? 0 : totalPnlUsd / trades.length,
    avgPnlPct: mean(trades.map((trade) => trade.pnlPct)),
    avgWinUsd: mean(wins.map((trade) => trade.pnlUsd)),
    avgLossUsd: mean(losses.map((trade) => trade.pnlUsd)),
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Number.POSITIVE_INFINITY : 0) : grossWin / grossLoss,
    avgHoldMinutes: mean(trades.map(holdMinutes)),
  };
}

// Group trades by a key, then summarize each group. Buckets are returned
// sorted by total PnL descending so the best/worst segments surface first.
function groupAndSummarize(trades: AnalyticsTrade[], keyOf: (trade: AnalyticsTrade) => string): AnalyticsBucket[] {
  const groups = new Map<string, AnalyticsTrade[]>();
  for (const trade of trades) {
    const key = keyOf(trade);
    const group = groups.get(key) ?? [];
    group.push(trade);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([label, group]) => summarize(label, group))
    .sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);
}

function scoreBucketLabel(score: number): string {
  const bucket = SCORE_BUCKETS.find((range) => score >= range.min && score <= range.max);
  return bucket?.label ?? 'unknown';
}

export function computeTradeAnalytics(trades: AnalyticsTrade[]): TradeAnalytics {
  return {
    overall: summarize('overall', trades),
    byReason: groupAndSummarize(trades, (trade) => trade.reason),
    byExitPriceSource: groupAndSummarize(trades, (trade) => trade.exitPriceSource || 'unknown'),
    byScoreBucket: groupAndSummarize(trades, (trade) => scoreBucketLabel(trade.score)),
    bySource: groupAndSummarize(trades, (trade) => trade.source || 'unknown'),
    byStrategy: groupAndSummarize(trades, (trade) => trade.strategyId || 'unknown'),
  };
}

// ---------------------------------------------------------------------------
// Candidate outcome (excursion) analytics — the counterfactual on scored
// candidates, traded or not. Answers: at each score level, how far did
// candidates run (MFE) and draw down (MAE) over the trade horizon, and how
// often would they have hit take-profit vs stop-loss? This is what informs
// where to set the score threshold.
// ---------------------------------------------------------------------------

export interface OutcomeRow {
  score: number;
  recommendation: string;
  scoredPriceUsd: number;
  outcomeHighUsd: number;
  outcomeLowUsd: number;
  outcomeLastUsd: number;
  outcomeFirstTakeProfitAt?: string | null;
  outcomeFirstStopLossAt?: string | null;
}

export interface OutcomeThresholds {
  takeProfitPct: number;
  stopLossPct: number;
}

export interface OutcomeBucket {
  label: string;
  candidates: number;
  avgMfePct: number;
  avgMaePct: number;
  avgFinalPct: number;
  reachedTpRatePct: number;
  hitSlRatePct: number;
  tpFirstRatePct: number;
  slFirstRatePct: number;
  // same-millisecond timestamp tie — extremely rare but distinct from unknown
  ambiguousRatePct: number;
  // both TP and SL hit but no crossing timestamps (pre-PR#7 legacy rows)
  unknownRatePct: number;
}

export interface OutcomeAnalytics {
  overall: OutcomeBucket;
  byScoreBucket: OutcomeBucket[];
  byRecommendation: OutcomeBucket[];
}

function firstCrossing(row: OutcomeRow, reachedTp: boolean, hitSl: boolean): 'tp' | 'sl' | 'ambiguous' | 'unknown' | 'none' {
  const tpAt = row.outcomeFirstTakeProfitAt;
  const slAt = row.outcomeFirstStopLossAt;
  if (tpAt && slAt) {
    const tpTime = new Date(tpAt).getTime();
    const slTime = new Date(slAt).getTime();
    if (Number.isFinite(tpTime) && Number.isFinite(slTime) && tpTime !== slTime) return tpTime < slTime ? 'tp' : 'sl';
    return 'ambiguous'; // same-millisecond tie
  }
  if (tpAt && reachedTp) return 'tp';
  if (slAt && hitSl) return 'sl';
  // both flags set but no timestamps — legacy rows collected before crossing-time tracking
  return reachedTp && hitSl ? 'unknown' : 'none';
}

function summarizeOutcomes(label: string, rows: OutcomeRow[], thresholds: OutcomeThresholds): OutcomeBucket {
  const excursions = rows.map((row) => {
    const mfePct = ((row.outcomeHighUsd - row.scoredPriceUsd) / row.scoredPriceUsd) * 100;
    const maePct = ((row.outcomeLowUsd - row.scoredPriceUsd) / row.scoredPriceUsd) * 100;
    const reachedTp = mfePct >= thresholds.takeProfitPct;
    const hitSl = maePct <= -thresholds.stopLossPct;
    return {
      mfePct,
      maePct,
      finalPct: ((row.outcomeLastUsd - row.scoredPriceUsd) / row.scoredPriceUsd) * 100,
      reachedTp,
      hitSl,
      first: firstCrossing(row, reachedTp, hitSl),
    };
  });
  const n = excursions.length;
  const reachedTp = excursions.filter((e) => e.reachedTp).length;
  const hitSl = excursions.filter((e) => e.hitSl).length;
  const tpFirst = excursions.filter((e) => e.first === 'tp').length;
  const slFirst = excursions.filter((e) => e.first === 'sl').length;
  const ambiguous = excursions.filter((e) => e.first === 'ambiguous').length;
  const unknown = excursions.filter((e) => e.first === 'unknown').length;

  return {
    label,
    candidates: n,
    avgMfePct: mean(excursions.map((e) => e.mfePct)),
    avgMaePct: mean(excursions.map((e) => e.maePct)),
    avgFinalPct: mean(excursions.map((e) => e.finalPct)),
    reachedTpRatePct: n === 0 ? 0 : (reachedTp / n) * 100,
    hitSlRatePct: n === 0 ? 0 : (hitSl / n) * 100,
    tpFirstRatePct: n === 0 ? 0 : (tpFirst / n) * 100,
    slFirstRatePct: n === 0 ? 0 : (slFirst / n) * 100,
    ambiguousRatePct: n === 0 ? 0 : (ambiguous / n) * 100,
    unknownRatePct: n === 0 ? 0 : (unknown / n) * 100,
  };
}

function groupOutcomes(
  rows: OutcomeRow[],
  keyOf: (row: OutcomeRow) => string,
  thresholds: OutcomeThresholds,
): OutcomeBucket[] {
  const groups = new Map<string, OutcomeRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([label, group]) => summarizeOutcomes(label, group, thresholds))
    .sort((a, b) => b.avgFinalPct - a.avgFinalPct);
}

export function computeOutcomeAnalytics(rows: OutcomeRow[], thresholds: OutcomeThresholds): OutcomeAnalytics {
  return {
    overall: summarizeOutcomes('overall', rows, thresholds),
    byScoreBucket: groupOutcomes(rows, (row) => scoreBucketLabel(row.score), thresholds),
    byRecommendation: groupOutcomes(rows, (row) => row.recommendation || 'unknown', thresholds),
  };
}

function outcomeBucketLine(bucket: OutcomeBucket): string {
  return (
    `  ${bucket.label.padEnd(14)} n=${String(bucket.candidates).padStart(5)} ` +
    `mfe=${bucket.avgMfePct.toFixed(1).padStart(7)}% mae=${bucket.avgMaePct.toFixed(1).padStart(7)}% ` +
    `final=${bucket.avgFinalPct.toFixed(1).padStart(7)}% ` +
    `hitTP=${bucket.reachedTpRatePct.toFixed(1).padStart(5)}% hitSL=${bucket.hitSlRatePct.toFixed(1).padStart(5)}% ` +
    `tpFirst=${bucket.tpFirstRatePct.toFixed(1).padStart(5)}% slFirst=${bucket.slFirstRatePct.toFixed(1).padStart(5)}% ` +
    `ambig=${bucket.ambiguousRatePct.toFixed(1).padStart(5)}% unkn=${bucket.unknownRatePct.toFixed(1).padStart(5)}%`
  );
}

export function renderOutcomeAnalytics(analytics: OutcomeAnalytics, thresholds: OutcomeThresholds): string {
  const lines = [
    'Hermes Paper Bot Candidate Outcomes (MFE/MAE)',
    `Tracked candidates: ${analytics.overall.candidates}`,
    `Thresholds: take-profit +${thresholds.takeProfitPct}% / stop-loss -${thresholds.stopLossPct}%`,
  ];

  if (analytics.overall.candidates === 0) {
    lines.push('', 'No tracked outcomes yet — run "track-outcomes" (or the run loop) to accumulate forward prices.');
    return `${lines.join('\n')}\n`;
  }

  lines.push('', 'By score bucket:');
  for (const bucket of analytics.byScoreBucket) lines.push(outcomeBucketLine(bucket));
  lines.push('', 'By recommendation:');
  for (const bucket of analytics.byRecommendation) lines.push(outcomeBucketLine(bucket));
  return `${lines.join('\n')}\n`;
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function profitFactor(value: number): string {
  return value === Number.POSITIVE_INFINITY ? 'inf' : value.toFixed(2);
}

function bucketLine(bucket: AnalyticsBucket): string {
  return (
    `  ${bucket.label.padEnd(24)} n=${String(bucket.trades).padStart(4)} ` +
    `win%=${bucket.winRatePct.toFixed(1).padStart(5)} ` +
    `pnl=${money(bucket.totalPnlUsd)} exp=${money(bucket.expectancyUsd)} ` +
    `pf=${profitFactor(bucket.profitFactor)} hold=${bucket.avgHoldMinutes.toFixed(1)}m`
  );
}

export function renderAnalyticsReport(analytics: TradeAnalytics): string {
  const o = analytics.overall;
  const lines = [
    'Hermes Paper Bot Analytics',
    `Closed trades: ${o.trades}`,
    '',
    'Overall:',
    `  trades=${o.trades} wins=${o.wins} losses=${o.losses} win%=${o.winRatePct.toFixed(1)}`,
    `  pnl=${money(o.totalPnlUsd)} expectancy=${money(o.expectancyUsd)} avgPct=${o.avgPnlPct.toFixed(2)}`,
    `  avgWin=${money(o.avgWinUsd)} avgLoss=${money(o.avgLossUsd)} profitFactor=${profitFactor(o.profitFactor)}`,
    `  avgHold=${o.avgHoldMinutes.toFixed(1)}m`,
  ];

  if (o.trades === 0) {
    lines.push('', 'No closed trades yet — run the bot to accumulate paper results.');
    return `${lines.join('\n')}\n`;
  }

  const section = (title: string, buckets: AnalyticsBucket[]) => {
    lines.push('', `${title}:`);
    for (const bucket of buckets) lines.push(bucketLine(bucket));
  };

  section('By strategy', analytics.byStrategy);
  section('By exit reason', analytics.byReason);
  section('By exit price source', analytics.byExitPriceSource);
  section('By score bucket', analytics.byScoreBucket);
  section('By discovery source', analytics.bySource);

  return `${lines.join('\n')}\n`;
}
