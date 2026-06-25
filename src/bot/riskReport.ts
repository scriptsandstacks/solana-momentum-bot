export interface RiskTradeRow {
  id: number;
  positionId: string;
  address: string;
  symbol: string;
  strategyId: string;
  score: number;
  reason: string;
  pnlUsd: number;
  pnlPct: number;
  openedAt: string;
  closedAt: string;
  routeInputSymbol: string | null;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
  priceChange5mPct: number | null;
  ageMinutes: number | null;
}

interface RiskBucket {
  label: string;
  trades: number;
  pnlUsd: number;
  expectancyUsd: number;
  wins: number;
  losses: number;
  winRatePct: number;
  avgPnlPct: number;
}

interface DuplicateExposure {
  address: string;
  symbol: string;
  trades: number;
  strategies: string[];
  pnlUsd: number;
  avgPnlPct: number;
}

export interface RiskReport {
  trades: number;
  totalPnlUsd: number;
  byStrategy: RiskBucket[];
  byRouteInput: RiskBucket[];
  byAgeBucket: RiskBucket[];
  byLiquidityBucket: RiskBucket[];
  byPriceChangeBucket: RiskBucket[];
  duplicateExposure: DuplicateExposure[];
  worstLosses: RiskTradeRow[];
}

export function computeRiskReport(rows: RiskTradeRow[]): RiskReport {
  return {
    trades: rows.length,
    totalPnlUsd: sum(rows.map((row) => row.pnlUsd)),
    byStrategy: group(rows, (row) => row.strategyId || 'unknown'),
    byRouteInput: group(rows, (row) => row.routeInputSymbol ?? 'unknown'),
    byAgeBucket: group(rows, (row) => bucketNumber(row.ageMinutes, [
      ['<3m', Number.NEGATIVE_INFINITY, 2.999],
      ['3-9m', 3, 9.999],
      ['10-29m', 10, 29.999],
      ['30m+', 30, Number.POSITIVE_INFINITY],
    ])),
    byLiquidityBucket: group(rows, (row) => bucketNumber(row.liquidityUsd, [
      ['<25k', Number.NEGATIVE_INFINITY, 24_999],
      ['25k-49k', 25_000, 49_999],
      ['50k-99k', 50_000, 99_999],
      ['100k+', 100_000, Number.POSITIVE_INFINITY],
    ])),
    byPriceChangeBucket: group(rows, (row) => bucketNumber(row.priceChange5mPct, [
      ['<0%', Number.NEGATIVE_INFINITY, -0.001],
      ['0-49%', 0, 49.999],
      ['50-99%', 50, 99.999],
      ['100%+', 100, Number.POSITIVE_INFINITY],
    ])),
    duplicateExposure: duplicateExposure(rows),
    worstLosses: [...rows].sort((a, b) => a.pnlPct - b.pnlPct).slice(0, 10),
  };
}

export function renderRiskReport(report: RiskReport): string {
  if (report.trades === 0) return 'No closed trades yet.\n';
  const lines = [
    'Risk Driver Report',
    `Trades: ${report.trades}  P&L: ${money(report.totalPnlUsd)}`,
    '',
    'By strategy:',
    ...renderBuckets(report.byStrategy),
    '',
    'By route input:',
    ...renderBuckets(report.byRouteInput),
    '',
    'By token age:',
    ...renderBuckets(report.byAgeBucket),
    '',
    'By liquidity:',
    ...renderBuckets(report.byLiquidityBucket),
    '',
    'By 5m price change:',
    ...renderBuckets(report.byPriceChangeBucket),
    '',
    'Duplicate mint exposure:',
  ];

  if (report.duplicateExposure.length === 0) {
    lines.push('  none');
  } else {
    for (const row of report.duplicateExposure.slice(0, 10)) {
      lines.push(
        `  ${row.symbol.padEnd(14)} trades=${String(row.trades).padStart(2)} pnl=${money(row.pnlUsd).padStart(9)} ` +
        `avgPct=${pct(row.avgPnlPct).padStart(8)} strategies=${row.strategies.join(',')}`,
      );
    }
  }

  lines.push('', 'Worst losses:');
  for (const row of report.worstLosses) {
    lines.push(
      `  #${row.id} ${row.symbol.padEnd(14)} ${row.strategyId.padEnd(21)} ` +
      `score=${String(row.score).padStart(2)} route=${(row.routeInputSymbol ?? '?').padEnd(4)} ` +
      `age=${formatMaybe(row.ageMinutes, 'm').padStart(6)} liq=${formatMoneyMaybe(row.liquidityUsd).padStart(8)} ` +
      `pnl=${money(row.pnlUsd).padStart(9)} pct=${pct(row.pnlPct).padStart(8)} reason=${row.reason}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

function group(rows: RiskTradeRow[], keyOf: (row: RiskTradeRow) => string): RiskBucket[] {
  const groups = new Map<string, RiskTradeRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  return [...groups.entries()]
    .map(([label, bucket]) => summarize(label, bucket))
    .sort((a, b) => a.pnlUsd - b.pnlUsd);
}

function summarize(label: string, rows: RiskTradeRow[]): RiskBucket {
  const wins = rows.filter((row) => row.pnlUsd > 0);
  const losses = rows.filter((row) => row.pnlUsd < 0);
  const pnlUsd = sum(rows.map((row) => row.pnlUsd));
  return {
    label,
    trades: rows.length,
    pnlUsd,
    expectancyUsd: rows.length === 0 ? 0 : pnlUsd / rows.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: rows.length === 0 ? 0 : (wins.length / rows.length) * 100,
    avgPnlPct: mean(rows.map((row) => row.pnlPct)),
  };
}

function duplicateExposure(rows: RiskTradeRow[]): DuplicateExposure[] {
  const groups = new Map<string, RiskTradeRow[]>();
  for (const row of rows) {
    const group = groups.get(row.address) ?? [];
    group.push(row);
    groups.set(row.address, group);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([address, group]) => ({
      address,
      symbol: group[0]?.symbol ?? address,
      trades: group.length,
      strategies: [...new Set(group.map((row) => row.strategyId))],
      pnlUsd: sum(group.map((row) => row.pnlUsd)),
      avgPnlPct: mean(group.map((row) => row.pnlPct)),
    }))
    .sort((a, b) => a.pnlUsd - b.pnlUsd);
}

function bucketNumber(
  value: number | null,
  buckets: Array<[label: string, min: number, max: number]>,
): string {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  return buckets.find(([, min, max]) => value >= min && value <= max)?.[0] ?? 'unknown';
}

function renderBuckets(buckets: RiskBucket[]): string[] {
  if (buckets.length === 0) return ['  none'];
  return buckets.map((bucket) => {
    const pf = bucket.losses === 0 ? 'n/a' : '';
    return (
      `  ${bucket.label.padEnd(22)} trades=${String(bucket.trades).padStart(3)} ` +
      `win%=${bucket.winRatePct.toFixed(1).padStart(5)} pnl=${money(bucket.pnlUsd).padStart(9)} ` +
      `exp=${money(bucket.expectancyUsd).padStart(8)} avgPct=${pct(bucket.avgPnlPct).padStart(8)}${pf}`
    );
  });
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function money(value: number): string {
  const sign = value >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function pct(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function formatMaybe(value: number | null, suffix: string): string {
  return value === null || !Number.isFinite(value) ? '?' : `${value.toFixed(0)}${suffix}`;
}

function formatMoneyMaybe(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '?';
  return `$${Math.round(value).toLocaleString('en-US')}`;
}
