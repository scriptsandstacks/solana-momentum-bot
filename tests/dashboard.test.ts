import { describe, expect, it } from 'vitest';
import { renderDashboard, type DashboardInput } from '../src/bot/dashboard.js';
import { computeTradeAnalytics, type AnalyticsTrade } from '../src/bot/analytics.js';

function emptyAnalytics() {
  return computeTradeAnalytics([]);
}

function trade(overrides: Partial<AnalyticsTrade>): AnalyticsTrade {
  return {
    reason: 'take_profit',
    exitPriceSource: 'fresh',
    score: 82,
    source: 'pumpportal+dexscreener',
    strategyId: 'freshLaunchMomentum',
    pnlUsd: 10,
    pnlPct: 40,
    openedAt: '2026-01-01T00:00:00.000Z',
    closedAt: '2026-01-01T00:10:00.000Z',
    ...overrides,
  };
}

const baseInput: DashboardInput = {
  mode: 'paper',
  generatedAt: '2026-06-06T12:00:00.000Z',
  openPositions: [],
  recentTrades: [],
  journalBlockers: 0,
  journalSummary: 'No incomplete live executions.',
  analytics: emptyAnalytics(),
};

describe('renderDashboard', () => {
  it('includes header with mode and timestamp', () => {
    const output = renderDashboard(baseInput);
    expect(output).toContain('Solana Trade Engine Dashboard');
    expect(output).toContain('2026-06-06T12:00:00.000Z');
    expect(output).toContain('mode=paper');
  });

  it('renders all required sections', () => {
    const output = renderDashboard(baseInput);
    expect(output).toContain('Live Readiness');
    expect(output).toContain('Wallet Balances');
    expect(output).toContain('Journal');
    expect(output).toContain('Open Positions');
    expect(output).toContain('Recent Trades');
    expect(output).toContain('Analytics Summary');
  });

  it('shows wallet skip message when no wallet configured', () => {
    const output = renderDashboard(baseInput);
    expect(output).toContain('skipped — wallet file or RPC URL not configured');
  });

  it('shows wallet balances when provided', () => {
    const output = renderDashboard({
      ...baseInput,
      walletBalances: {
        publicKey: 'WaLLeT1234',
        sol: 0.25,
        solUsd: 35.0,
        solPriceUsd: 140.0,
        usdc: 50.0,
        usdt: 0.0,
        totalUsd: 85.0,
        solLamports: BigInt(250_000_000),
        reserveStatus: 'OK',
        minReserveLamports: BigInt(100_000_000),
      },
    });
    expect(output).toContain('WaLLeT1234');
    expect(output).toContain('SOL: 0.250000');
    expect(output).toContain('USDC: $50.00');
    expect(output).toContain('fee reserve: OK');
  });

  it('shows wallet error when balance fetch fails', () => {
    const output = renderDashboard({
      ...baseInput,
      walletError: 'Wallet balance fetch failed: connection refused',
    });
    expect(output).toContain('Wallet balance fetch failed: connection refused');
  });

  it('shows (none) when there are no open positions or trades', () => {
    const output = renderDashboard(baseInput);
    // two (none) entries — one for positions, one for trades
    const noneMatches = output.match(/\(none\)/g);
    expect(noneMatches?.length).toBe(2);
  });

  it('renders open position details', () => {
    const output = renderDashboard({
      ...baseInput,
      openPositions: [
        {
          id: 'pos-abc-123',
          chain: 'solana',
          symbol: 'BONK',
          strategyId: 'freshLaunchMomentum',
          entryPriceUsd: 0.000015,
          quantity: 5_000_000,
          score: 85,
          openedAt: '2026-06-06T11:50:00.000Z',
        },
      ],
    });
    expect(output).toContain('SOLANA BONK');
    expect(output).toContain('score=85');
    expect(output).toContain('strat=freshLaunchMomentum');
  });

  it('renders recent trade details', () => {
    const output = renderDashboard({
      ...baseInput,
      recentTrades: [
        {
          positionId: 'trade-xyz-999',
          chain: 'solana',
          symbol: 'WIF',
          reason: 'take_profit',
          pnlUsd: 12.5,
          pnlPct: 50,
          closedAt: '2026-06-06T11:55:00.000Z',
        },
      ],
    });
    expect(output).toContain('SOLANA WIF');
    expect(output).toContain('reason=take_profit');
    expect(output).toContain('+$12.50');
  });

  it('renders journal blocker count in section header', () => {
    const output = renderDashboard({
      ...baseInput,
      journalBlockers: 3,
      journalSummary: 'entry-1 pending\nentry-2 pending\nentry-3 pending',
    });
    expect(output).toContain('Journal (3 blocker(s))');
  });

  it('renders analytics summary with closed trade stats', () => {
    const analytics = computeTradeAnalytics([
      trade({ pnlUsd: 20, pnlPct: 40 }),
      trade({ pnlUsd: -10, pnlPct: -20, reason: 'stop_loss' }),
    ]);
    const output = renderDashboard({ ...baseInput, analytics });
    expect(output).toContain('Closed trades: 2');
    expect(output).toContain('Win rate: 50.0%');
  });

  it('shows execution quality line when live fee data is present', () => {
    const analytics = computeTradeAnalytics([
      trade({
        pnlUsd: 49.98,
        entryPriceUsd: 1.0,
        exitPriceUsd: 1.5,
        quantity: 100,
        entryNetworkFeeUsd: 0.01,
        exitNetworkFeeUsd: 0.01,
      }),
    ]);
    const output = renderDashboard({ ...baseInput, analytics });
    expect(output).toContain('Execution (live)');
    expect(output).toContain('fees=');
  });

  it('shows empty analytics message when no trades', () => {
    const output = renderDashboard({ ...baseInput, analytics: emptyAnalytics() });
    expect(output).toContain('No closed trades yet.');
  });
});
