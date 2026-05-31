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
  };
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

  section('By exit reason', analytics.byReason);
  section('By exit price source', analytics.byExitPriceSource);
  section('By score bucket', analytics.byScoreBucket);
  section('By discovery source', analytics.bySource);

  return `${lines.join('\n')}\n`;
}
