import { describe, expect, it } from 'vitest';
import {
  buildStaleRecovery,
  buildOrphanedRecovery,
  renderRecoveryPlan,
  renderRecoverySummary,
  RECOVERY_STRATEGY_ID,
} from '../src/execution/positionRecovery.js';
import type { PaperPosition, TokenCandidate } from '../src/types/domain.js';
import { USDC_MINT } from '../src/execution/solanaTransactionHistory.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeToken(mint: string, symbol: string): TokenCandidate {
  return {
    chain: 'solana',
    address: mint,
    symbol,
    name: symbol,
    pairAddress: `pair-${mint}`,
    priceUsd: 0.001,
    liquidityUsd: 50_000,
    volume5mUsd: 10_000,
    volume1hUsd: 50_000,
    priceChange5mPct: 5,
    buys5m: 40,
    sells5m: 15,
    ageMinutes: 20,
    source: 'test',
    routeAvailable: true,
    estimatedSlippageBps: 100,
    strategyId: RECOVERY_STRATEGY_ID,
  };
}

function makePosition(overrides: Partial<PaperPosition> = {}): PaperPosition {
  return {
    id: 'live-1',
    token: makeToken('mint-abc', 'PUMP'),
    score: 82,
    entryPriceUsd: 0.001,
    quantity: 25_000,
    openedAt: new Date('2026-01-01T10:00:00Z'),
    highWaterMarkUsd: 0.0015,
    lastMarkUsd: 0.0012,
    ...overrides,
  };
}

const CLOSED_AT = new Date('2026-01-01T11:00:00Z');

// ─── buildStaleRecovery ───────────────────────────────────────────────────────

describe('buildStaleRecovery', () => {
  it('closes at lastMarkUsd when available', () => {
    const position = makePosition({ lastMarkUsd: 0.0012, entryPriceUsd: 0.001 });
    const r = buildStaleRecovery(position, CLOSED_AT);

    expect(r.type).toBe('stale');
    expect(r.trade.exitPriceUsd).toBe(0.0012);
    expect(r.trade.exitPriceSource).toBe('last_mark');
    expect(r.trade.reason).toBe('manual');
  });

  it('falls back to entryPriceUsd when lastMarkUsd is undefined', () => {
    const position = makePosition({ lastMarkUsd: undefined, entryPriceUsd: 0.001 });
    const r = buildStaleRecovery(position, CLOSED_AT);

    expect(r.trade.exitPriceUsd).toBe(0.001);
    expect(r.trade.exitPriceSource).toBe('entry_fallback');
  });

  it('uses entry_fallback when lastMark equals entry (never re-priced)', () => {
    const position = makePosition({ lastMarkUsd: 0.001, entryPriceUsd: 0.001 });
    const r = buildStaleRecovery(position, CLOSED_AT);
    expect(r.trade.exitPriceSource).toBe('entry_fallback');
  });

  it('computes pnl correctly for a winning position', () => {
    const position = makePosition({ entryPriceUsd: 0.001, quantity: 10_000, lastMarkUsd: 0.002 });
    const r = buildStaleRecovery(position, CLOSED_AT);

    // entry = 0.001 × 10000 = $10; exit = 0.002 × 10000 = $20; pnl = +$10
    expect(r.pnlUsd).toBeCloseTo(10);
    expect(r.trade.pnlPct).toBeCloseTo(100);
  });

  it('computes pnl correctly for a losing position', () => {
    const position = makePosition({ entryPriceUsd: 0.001, quantity: 10_000, lastMarkUsd: 0.0005 });
    const r = buildStaleRecovery(position, CLOSED_AT);

    // entry = $10; exit = $5; pnl = -$5
    expect(r.pnlUsd).toBeCloseTo(-5);
    expect(r.trade.pnlPct).toBeCloseTo(-50);
  });

  it('preserves all position fields on the trade', () => {
    const position = makePosition();
    const r = buildStaleRecovery(position, CLOSED_AT);

    expect(r.trade.positionId).toBe(position.id);
    expect(r.trade.token).toBe(position.token);
    expect(r.trade.score).toBe(position.score);
    expect(r.trade.quantity).toBe(position.quantity);
    expect(r.trade.openedAt).toBe(position.openedAt);
    expect(r.trade.closedAt).toBe(CLOSED_AT);
  });
});

// ─── buildOrphanedRecovery ────────────────────────────────────────────────────

describe('buildOrphanedRecovery', () => {
  const holding = { mint: 'mint-orphan', uiAmount: 15_000 };

  it('builds a synthetic position from market data', () => {
    const candidate = makeToken('mint-orphan', 'LOST');
    const r = buildOrphanedRecovery(holding, candidate, 'live-99', CLOSED_AT);

    expect(r.type).toBe('orphaned');
    expect(r.position.id).toBe('live-99');
    expect(r.position.token.address).toBe('mint-orphan');
    expect(r.position.quantity).toBe(15_000);
    expect(r.position.entryPriceUsd).toBe(candidate.priceUsd);
    expect(r.position.score).toBe(0); // unknown at recovery time
    expect(r.position.token.strategyId).toBe(RECOVERY_STRATEGY_ID);
    expect(r.currentPriceUsd).toBe(candidate.priceUsd);
  });

  it('returns undefined position when candidate is missing', () => {
    const r = buildOrphanedRecovery(holding, undefined, 'live-99', CLOSED_AT);

    expect(r.currentPriceUsd).toBeUndefined();
    expect(r.type).toBe('orphaned');
  });

  it('returns undefined position when candidate price is zero', () => {
    const candidate = { ...makeToken('mint-orphan', 'ZERO'), priceUsd: 0 };
    const r = buildOrphanedRecovery(holding, candidate, 'live-99', CLOSED_AT);

    expect(r.currentPriceUsd).toBeUndefined();
  });

  it('sets highWaterMarkUsd and lastMarkUsd to current price', () => {
    const candidate = makeToken('mint-orphan', 'LOST');
    const r = buildOrphanedRecovery(holding, candidate, 'live-99', CLOSED_AT);

    expect(r.position.highWaterMarkUsd).toBe(candidate.priceUsd);
    expect(r.position.lastMarkUsd).toBe(candidate.priceUsd);
  });

  it('uses transaction history for entry basis and audit metadata when available', () => {
    const candidate = makeToken('mint-orphan', 'LOST');
    const r = buildOrphanedRecovery(holding, candidate, 'live-99', CLOSED_AT, {
      buy: {
        signature: 'sig-buy',
        inputMint: USDC_MINT,
        inputAmount: 25_000_000n,
        outputAmount: 20_000_000_000n,
        networkFeeLamports: 5_000,
        blockTime: 1_767_261_600,
      },
      entryPriceUsd: 0.00125,
      entryNetworkFeeUsd: 0.00075,
    });

    expect(r.entryPriceSource).toBe('transaction_history');
    expect(r.position.entryPriceUsd).toBe(0.00125);
    expect(r.position.entryTxSignature).toBe('sig-buy');
    expect(r.position.entryNetworkFeeLamports).toBe(5_000);
    expect(r.position.entryNetworkFeeUsd).toBe(0.00075);
    expect(r.position.openedAt).toEqual(new Date(1_767_261_600_000));
  });
});

// ─── renderRecoveryPlan ───────────────────────────────────────────────────────

describe('renderRecoveryPlan', () => {
  it('returns no-recovery message when both lists are empty', () => {
    const output = renderRecoveryPlan([], []);
    expect(output).toContain('No recovery needed');
  });

  it('includes STALE section with pnl info', () => {
    const position = makePosition({ entryPriceUsd: 0.001, quantity: 10_000, lastMarkUsd: 0.0008 });
    const r = buildStaleRecovery(position, CLOSED_AT);
    const output = renderRecoveryPlan([r], []);

    expect(output).toContain('STALE');
    expect(output).toContain('live-1');
    expect(output).toContain('close position');
  });

  it('includes ORPHANED section with market price', () => {
    const holding = { mint: 'mint-x', uiAmount: 5_000 };
    const candidate = makeToken('mint-x', 'XYZ');
    const r = buildOrphanedRecovery(holding, candidate, 'live-50', CLOSED_AT);
    const output = renderRecoveryPlan([], [r]);

    expect(output).toContain('ORPHANED');
    expect(output).toContain('live-50');
    expect(output).toContain('approximate');
  });

  it('shows transaction-history basis when available', () => {
    const holding = { mint: 'mint-x', uiAmount: 5_000 };
    const candidate = makeToken('mint-x', 'XYZ');
    const r = buildOrphanedRecovery(holding, candidate, 'live-50', CLOSED_AT, {
      buy: {
        signature: 'sig-buy',
        inputMint: USDC_MINT,
        inputAmount: 5_000_000n,
        outputAmount: 5_000_000_000n,
        networkFeeLamports: 5_000,
      },
      entryPriceUsd: 0.001,
    });
    const output = renderRecoveryPlan([], [r]);

    expect(output).toContain('from tx=sig-buy');
    expect(output).not.toContain('approximate');
  });

  it('marks skipped orphans when price unavailable', () => {
    const holding = { mint: 'mint-noprice', uiAmount: 100 };
    const r = buildOrphanedRecovery(holding, undefined, 'live-51', CLOSED_AT);
    const output = renderRecoveryPlan([], [r]);

    expect(output).toContain('SKIPPED');
    expect(output).toContain('mint-noprice');
  });

  it('shows a header with counts', () => {
    const pos = makePosition();
    const stale = buildStaleRecovery(pos, CLOSED_AT);
    const orphan = buildOrphanedRecovery({ mint: 'mint-o', uiAmount: 100 }, makeToken('mint-o', 'O'), 'live-2', CLOSED_AT);
    const output = renderRecoveryPlan([stale], [orphan]);

    expect(output).toContain('1 stale');
    expect(output).toContain('1 orphaned');
  });
});

// ─── renderRecoverySummary ────────────────────────────────────────────────────

describe('renderRecoverySummary', () => {
  it('reports all three counts', () => {
    const s = renderRecoverySummary(2, 1, 1);
    expect(s).toContain('2 stale');
    expect(s).toContain('1 orphaned');
    expect(s).toContain('1 skipped');
  });

  it('returns nothing-to-recover when all zero', () => {
    expect(renderRecoverySummary(0, 0, 0)).toContain('Nothing');
  });

  it('omits zero counts', () => {
    const s = renderRecoverySummary(0, 3, 0);
    expect(s).not.toContain('stale');
    expect(s).toContain('3 orphaned');
  });
});
