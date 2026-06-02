interface RecentScoreRow {
  chain: string;
  address?: string;
  symbol: string;
  name?: string;
  pairAddress?: string;
  priceUsd: number;
  liquidityUsd: number;
  volume5mUsd: number;
  routeInputSymbol?: string;
  // SQLite INTEGER tristate: 1=ok, 0=no sell route, null=not checked
  sellRouteAvailable?: number | null;
  score: number;
  recommendation: string;
  createdAt: string;
}

interface OpenPositionRow {
  id: string;
  chain: string;
  address?: string;
  symbol: string;
  strategyId?: string;
  entryPriceUsd: number;
  quantity: number;
  score: number;
  openedAt: string;
}

interface ClosedTradeRow {
  positionId: string;
  chain: string;
  address?: string;
  symbol: string;
  strategyId?: string;
  entryPriceUsd?: number;
  exitPriceUsd?: number;
  quantity?: number;
  openedAt?: string;
  reason: string;
  exitPriceSource?: string;
  pnlUsd: number;
  pnlPct: number;
  closedAt: string;
}

interface PumpPortalEventRow {
  id: number;
  eventType: string;
  tokenMint?: string;
  symbol?: string;
  name?: string;
  signature?: string;
  rawJson: string;
  receivedAt: string;
  processingStatus?: string;
  processingNote?: string;
}

interface StorageReportInput {
  recentScores: RecentScoreRow[];
  openPositions: OpenPositionRow[];
  closedTrades: ClosedTradeRow[];
  pumpPortalEvents?: PumpPortalEventRow[];
}

export function renderStorageReport(input: StorageReportInput): string {
  const totalPnl = input.closedTrades.reduce((sum, trade) => sum + trade.pnlUsd, 0);
  const wins = input.closedTrades.filter((trade) => trade.pnlUsd > 0).length;
  const winRate = input.closedTrades.length === 0 ? 0 : (wins / input.closedTrades.length) * 100;
  const lines = [
    'Hermes Paper Bot Storage Report',
    `Recent scores: ${input.recentScores.length}`,
    `Open positions: ${input.openPositions.length}`,
    `Closed trades: ${input.closedTrades.length}`,
    `PumpPortal events: ${input.pumpPortalEvents?.length ?? 0}`,
    `PnL: $${totalPnl.toFixed(2)}`,
    `Win rate: ${winRate.toFixed(1)}%`,
  ];

  lines.push('', 'Top recent scores:');
  for (const row of input.recentScores.slice(0, 10)) {
    const sellTag =
      row.sellRouteAvailable === 1 ? ' sell=ok' : row.sellRouteAvailable === 0 ? ' sell=NO' : '';
    lines.push(
      `${row.chain.toUpperCase()} ${row.symbol} score=${row.score} rec=${row.recommendation} route=${row.routeInputSymbol ?? 'none'}${sellTag} price=$${row.priceUsd} liq=$${Math.round(row.liquidityUsd)} vol5m=$${Math.round(row.volume5mUsd)} at=${row.createdAt}`,
    );
  }

  lines.push('', 'Open positions:');
  for (const row of input.openPositions.slice(0, 10)) {
    const strat = row.strategyId ? ` strat=${row.strategyId}` : '';
    lines.push(
      `${row.id} ${row.chain.toUpperCase()} ${row.symbol}${strat} entry=$${row.entryPriceUsd} qty=${row.quantity.toFixed(4)} score=${row.score} opened=${row.openedAt}`,
    );
  }

  lines.push('', 'Recent closed trades:');
  for (const row of input.closedTrades.slice(0, 10)) {
    const source = row.exitPriceSource ? ` source=${row.exitPriceSource}` : '';
    const strat = row.strategyId ? ` strat=${row.strategyId}` : '';
    lines.push(
      `${row.positionId} ${row.chain.toUpperCase()} ${row.symbol}${strat} reason=${row.reason}${source} pnl=$${row.pnlUsd.toFixed(2)} pct=${row.pnlPct.toFixed(2)} closed=${row.closedAt}`,
    );
  }

  lines.push('', 'Recent PumpPortal events:');
  for (const row of (input.pumpPortalEvents ?? []).slice(0, 10)) {
    lines.push(
      `${row.eventType} ${row.symbol ?? 'unknown'} mint=${row.tokenMint ?? 'unknown'} status=${row.processingStatus ?? 'unknown'} note=${row.processingNote ?? 'none'} sig=${row.signature ?? 'unknown'} at=${row.receivedAt}`,
    );
  }

  return `${lines.join('\n')}\n`;
}
