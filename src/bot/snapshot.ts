import type { LiveReadinessReport } from '../execution/liveReadiness.js';
import type { TradeAnalytics } from './analytics.js';

const SEP = '─'.repeat(60);
const THICK = '═'.repeat(60);

function section(title: string): string {
  return `\n${SEP}\n${title}\n${SEP}`;
}

// ─── input shapes (all optional so callers omit sections they can't populate) ─

export interface SnapshotWalletBalances {
  publicKey: string;
  sol: number;
  solUsd: number;
  solPriceUsd: number;
  usdc: number;
  usdt: number;
  totalUsd: number;
  solLamports: bigint;
  reserveStatus: 'OK' | 'LOW';
  minReserveLamports: bigint;
}

export interface SnapshotOpenPosition {
  id: string;
  chain: string;
  symbol: string;
  strategyId?: string;
  entryPriceUsd: number;
  quantity: number;
  score: number;
  openedAt: string;
  entryTxSignature?: string;
  entryNetworkFeeUsd?: number;
}

export interface SnapshotClosedTrade {
  positionId: string;
  chain: string;
  symbol: string;
  reason: string;
  exitPriceSource?: string;
  pnlUsd: number;
  pnlPct: number;
  closedAt: string;
  exitTxSignature?: string;
}

export interface SnapshotInput {
  mode: 'paper' | 'live';
  generatedAt: string;
  readiness?: LiveReadinessReport;
  walletBalances?: SnapshotWalletBalances;
  walletError?: string;
  openPositions: SnapshotOpenPosition[];
  recentTrades: SnapshotClosedTrade[];
  journalBlockers: number;
  journalSummary: string;
  analytics: TradeAnalytics;
}

function sign(n: number): string {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

function positionAge(openedAt: string, now: string): string {
  const ms = new Date(now).getTime() - new Date(openedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms / 60_000)}m` : '?m';
}

function readinessSection(report: LiveReadinessReport): string {
  const lines: string[] = [];
  const statusIcon = (s: string) => (s === 'pass' ? 'PASS' : s === 'warn' ? 'WARN' : 'BLOK');
  for (const check of report.checks) {
    lines.push(`  [${statusIcon(check.status)}] ${check.label}: ${check.detail}`);
  }
  const overall = report.ready ? 'READY FOR LIVE' : `NOT READY (${report.block} blocker(s))`;
  lines.push(`\n  ${overall} — pass=${report.pass} warn=${report.warn} block=${report.block}`);
  return lines.join('\n');
}

function walletSection(w: SnapshotWalletBalances): string {
  const lines: string[] = [
    `  Wallet: ${w.publicKey}`,
    `  SOL: ${w.sol.toFixed(6)} ($${w.solUsd.toFixed(2)} at $${w.solPriceUsd.toFixed(2)}/SOL)`,
    `  USDC: $${w.usdc.toFixed(2)}   USDT: $${w.usdt.toFixed(2)}`,
    `  Total route-input value: $${w.totalUsd.toFixed(2)}`,
    `  SOL fee reserve: ${w.reserveStatus} (${w.solLamports} / ${w.minReserveLamports} lamports)`,
  ];
  return lines.join('\n');
}

function positionsSection(positions: SnapshotOpenPosition[], now: string): string {
  if (positions.length === 0) return '  (none)';
  return positions
    .map((p) => {
      const strat = p.strategyId ? ` strat=${p.strategyId}` : '';
      const fee = p.entryNetworkFeeUsd != null ? ` entryFee=$${p.entryNetworkFeeUsd.toFixed(4)}` : '';
      const tx = p.entryTxSignature ? ` tx=${p.entryTxSignature.slice(0, 16)}…` : '';
      return (
        `  ${p.id.slice(0, 8)}  ${p.chain.toUpperCase()} ${p.symbol}${strat}` +
        `  entry=$${p.entryPriceUsd.toPrecision(4)}  qty=${p.quantity.toFixed(4)}` +
        `  score=${p.score}${fee}${tx}  age=${positionAge(p.openedAt, now)}`
      );
    })
    .join('\n');
}

function tradesSection(trades: SnapshotClosedTrade[]): string {
  if (trades.length === 0) return '  (none)';
  return trades
    .map((t) => {
      const pct = t.pnlPct >= 0 ? `+${t.pnlPct.toFixed(1)}%` : `${t.pnlPct.toFixed(1)}%`;
      const tx = t.exitTxSignature ? ` tx=${t.exitTxSignature.slice(0, 16)}…` : '';
      const src = t.exitPriceSource && t.exitPriceSource !== 'fresh' ? ` src=${t.exitPriceSource}` : '';
      return (
        `  ${t.positionId.slice(0, 8)}  ${t.chain.toUpperCase()} ${t.symbol}` +
        `  reason=${t.reason}  pnl=${sign(t.pnlUsd)} (${pct})${src}${tx}  closed=${t.closedAt.slice(0, 16)}`
      );
    })
    .join('\n');
}

function analyticsSummarySection(a: TradeAnalytics): string {
  const o = a.overall;
  if (o.trades === 0) return '  No closed trades yet.';
  const pf = o.profitFactor === Number.POSITIVE_INFINITY ? 'inf' : o.profitFactor.toFixed(2);
  const lines = [
    `  Closed trades: ${o.trades}   Win rate: ${o.winRatePct.toFixed(1)}%   P&L: $${o.totalPnlUsd.toFixed(2)}`,
    `  Expectancy: $${o.expectancyUsd.toFixed(2)}/trade   Profit factor: ${pf}   Avg hold: ${o.avgHoldMinutes.toFixed(1)}m`,
  ];
  if (a.executionQuality.liveTrades > 0) {
    const eq = a.executionQuality;
    lines.push(
      `  Execution (live): gross=$${eq.totalGrossPnlUsd.toFixed(2)}  fees=$${eq.totalNetworkFeesUsd.toFixed(4)}` +
        `  avg fee/trade=$${eq.avgNetworkFeePerTradeUsd.toFixed(4)}  break-even move=${eq.avgBreakEvenMovePct.toFixed(3)}%`,
    );
  }
  return lines.join('\n');
}

export function renderSnapshot(input: SnapshotInput): string {
  const lines: string[] = [
    THICK,
    'Solana Trade Engine Snapshot',
    `${input.generatedAt}  mode=${input.mode}`,
    THICK,
  ];

  // ── Live Readiness ──
  lines.push(section('Live Readiness'));
  if (input.readiness) {
    lines.push(readinessSection(input.readiness));
  } else {
    lines.push('  (skipped — readiness check requires config)');
  }

  // ── Wallet Balances ──
  lines.push(section('Wallet Balances'));
  if (input.walletBalances) {
    lines.push(walletSection(input.walletBalances));
  } else if (input.walletError) {
    lines.push(`  ${input.walletError}`);
  } else {
    lines.push('  (skipped — wallet file or RPC URL not configured)');
  }

  // ── Journal ──
  lines.push(section(`Journal (${input.journalBlockers} blocker(s))`));
  lines.push(`  ${input.journalSummary}`);

  // ── Open Positions ──
  lines.push(section(`Open Positions (${input.openPositions.length})`));
  lines.push(positionsSection(input.openPositions, input.generatedAt));

  // ── Recent Trades ──
  lines.push(section(`Recent Trades (last ${input.recentTrades.length})`));
  lines.push(tradesSection(input.recentTrades));

  // ── Analytics Summary ──
  lines.push(section('Analytics Summary'));
  lines.push(analyticsSummarySection(input.analytics));

  lines.push(`\n${THICK}\n`);
  return lines.join('\n');
}
