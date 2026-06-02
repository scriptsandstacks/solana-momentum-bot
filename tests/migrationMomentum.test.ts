import { describe, expect, it } from 'vitest';
import { migrationMomentumStrategy, MIGRATION_MOMENTUM_STRATEGY_ID } from '../src/strategies/migrationMomentum.js';
import { freshLaunchMomentumStrategy, FRESH_LAUNCH_MOMENTUM_STRATEGY_ID } from '../src/strategies/freshLaunchMomentum.js';
import { processPumpPortalEvents } from '../src/bot/pumpProcess.js';
import type { OpportunityScore, PaperPosition, TokenCandidate } from '../src/types/domain.js';

// ── Strategy routing ───────────────────────────────────────────────────────────

describe('strategy event routing', () => {
  it('freshLaunchMomentum accepts new_token, rejects migration', () => {
    expect(freshLaunchMomentumStrategy.acceptsEventType('new_token')).toBe(true);
    expect(freshLaunchMomentumStrategy.acceptsEventType('migration')).toBe(false);
    expect(freshLaunchMomentumStrategy.acceptsEventType('unknown')).toBe(false);
  });

  it('migrationMomentum accepts migration, rejects new_token', () => {
    expect(migrationMomentumStrategy.acceptsEventType('migration')).toBe(true);
    expect(migrationMomentumStrategy.acceptsEventType('new_token')).toBe(false);
  });

  it('strategies have distinct IDs', () => {
    expect(freshLaunchMomentumStrategy.id).toBe(FRESH_LAUNCH_MOMENTUM_STRATEGY_ID);
    expect(migrationMomentumStrategy.id).toBe(MIGRATION_MOMENTUM_STRATEGY_ID);
    expect(freshLaunchMomentumStrategy.id).not.toBe(migrationMomentumStrategy.id);
  });
});

// ── Migration scorer ───────────────────────────────────────────────────────────

function migrationCandidate(overrides: Partial<TokenCandidate> = {}): TokenCandidate {
  return {
    chain: 'solana',
    address: 'migration-mint',
    symbol: 'MEME',
    name: 'Meme Token',
    pairAddress: 'pair-1',
    priceUsd: 0.001,
    liquidityUsd: 80_000,  // strong post-migration liquidity
    volume5mUsd: 35_000,
    volume1hUsd: 200_000,
    priceChange5mPct: 15,  // healthy post-migration momentum
    buys5m: 70,
    sells5m: 25,
    ageMinutes: 60,         // within migration window (30–360 min)
    source: 'pumpportal+dexscreener',
    routeAvailable: true,
    estimatedSlippageBps: 150,
    sellRouteAvailable: true,
    ...overrides,
  };
}

describe('migrationMomentum scorer', () => {
  it('scores a strong migration candidate as paper_trade', () => {
    const score = migrationMomentumStrategy.scoreCandidate(migrationCandidate());
    expect(score.recommendation).toBe('paper_trade');
    expect(score.total).toBeGreaterThanOrEqual(70);
    expect(score.reasons).toContain('strong_migration_liquidity');
    expect(score.reasons).toContain('high_migration_volume');
    expect(score.reasons).toContain('strong_buy_pressure');
    expect(score.reasons).toContain('within_migration_window');
  });

  it('penalizes a stale migration (>720 min old)', () => {
    const score = migrationMomentumStrategy.scoreCandidate(migrationCandidate({ ageMinutes: 800 }));
    expect(score.risks).toContain('stale_migration');
  });

  it('penalizes a honeypot (no sell route) heavily and prevents paper_trade recommendation', () => {
    const score = migrationMomentumStrategy.scoreCandidate(migrationCandidate({ sellRouteAvailable: false }));
    expect(score.risks).toContain('no_sell_route');
    // -50 penalty knocks even a strong candidate out of paper_trade range.
    expect(score.recommendation).not.toBe('paper_trade');
  });

  it('uses a lower paper_trade threshold (70) than fresh launch (75)', () => {
    expect(migrationMomentumStrategy.config.minScoreToEnter).toBe(70);
    expect(freshLaunchMomentumStrategy.config.minScoreToEnter).toBe(75);
  });
});

// ── Pipeline routing ───────────────────────────────────────────────────────────

function strongMigrationCandidate(address: string): TokenCandidate {
  return migrationCandidate({ address, source: 'pumpportal+dexscreener' });
}

describe('processPumpPortalEvents — strategy routing', () => {
  it('routes migration events to migrationMomentum and new_token events to freshLaunchMomentum', async () => {
    const scored: Array<{ candidate: TokenCandidate; score: OpportunityScore }> = [];

    await processPumpPortalEvents({
      store: {
        listPendingPumpPortalEvents: () => [
          { id: 1, eventType: 'new_token', tokenMint: 'mint-new', rawJson: '{}', receivedAt: '2026-01-01T00:00:00Z' },
          { id: 2, eventType: 'migration', tokenMint: 'mint-mig', rawJson: '{}', receivedAt: '2026-01-01T00:00:00Z' },
        ],
        markPumpPortalEventProcessed: () => undefined,
        saveScoredCandidate: (c, s) => scored.push({ candidate: c, score: s }),
        saveOpenPosition: () => undefined,
      },
      solanaConfig: { enabled: true, minLiquidityUsd: 5_000, minVolume5mUsd: 1_000, maxSlippageBps: 500 },
      paper: { startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 10 },
      minimumScoreToEnter: 70,
      strategies: [freshLaunchMomentumStrategy, migrationMomentumStrategy],
      fetchCandidates: async (mints) => mints.map((m) => strongMigrationCandidate(m)),
      checkRoute: async () => ({ routeAvailable: true, estimatedSlippageBps: 100, routeInputMint: 'u', routeInputSymbol: 'USDC', sellRouteAvailable: true }),
      checkAuthority: null,
    });

    const newTokenEntry = scored.find((s) => s.candidate.address === 'mint-new');
    const migEntry = scored.find((s) => s.candidate.address === 'mint-mig');

    expect(newTokenEntry?.candidate.strategyId).toBe(FRESH_LAUNCH_MOMENTUM_STRATEGY_ID);
    expect(migEntry?.candidate.strategyId).toBe(MIGRATION_MOMENTUM_STRATEGY_ID);
  });
});

// ── Conviction sizing ──────────────────────────────────────────────────────────

describe('resolvePositionSizeUsd — conviction tiers', () => {
  it('freshLaunchMomentum: sizes up at score 90+, full at 80-89, sizes down at 75-79', () => {
    const base = 25;
    expect(freshLaunchMomentumStrategy.resolvePositionSizeUsd(90, base)).toBeCloseTo(37.5); // 1.5x
    expect(freshLaunchMomentumStrategy.resolvePositionSizeUsd(85, base)).toBeCloseTo(25);   // 1.0x
    expect(freshLaunchMomentumStrategy.resolvePositionSizeUsd(75, base)).toBeCloseTo(18.75); // 0.75x
  });

  it('migrationMomentum: sizes up at score 85+, full below', () => {
    const base = 25;
    expect(migrationMomentumStrategy.resolvePositionSizeUsd(85, base)).toBeCloseTo(31.25); // 1.25x
    expect(migrationMomentumStrategy.resolvePositionSizeUsd(75, base)).toBeCloseTo(25);    // 1.0x
  });
});
