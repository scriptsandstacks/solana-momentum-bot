// Migration Momentum — targets tokens completing their Pump.fun bonding curve
// and migrating to Raydium. This is a structurally different event from a new
// token launch and requires different signal weights and exit rules.
//
// The migration edge:
//   When a token's bonding curve reaches 100% completion (~$69K raised), the
//   protocol executes a large buy that seeds Raydium liquidity. This mechanical
//   buy creates upward price pressure, and the token — having already survived
//   price discovery on Pump.fun — arrives on Raydium with proven demand.
//   The migration pump is typically sharper and shorter than a fresh launch.
//
// Key differences from freshLaunchMomentum:
//   - Age window: 30 min–6 h (migrations can be older; age is less important)
//   - Liquidity: weighted more heavily (token proved demand through bonding curve)
//   - Hold horizon: shorter (20 min) — migration pumps peak and fade quickly
//   - Trailing arm: tighter (15%) — enter closer to the event, capture fast move
//   - minScore: 70 (slightly lower — the migration itself is a quality filter)
//
// Entry: 'migration' events from PumpPortal only (not new_token).

import type { OpportunityScore, TokenCandidate } from '../types/domain.js';
import type { StrategyConfig, TradingStrategy } from './types.js';

export const MIGRATION_MOMENTUM_STRATEGY_ID = 'migrationMomentum';

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

// Migration-specific scorer. Weights liquidity and sell-route availability
// heavily (bonding curve completion means these are real tokens with real liquidity)
// and is more forgiving on age (tokens arriving via migration are expected to be
// 30 min–several hours old, not fresh mints).
function scoreMigrationCandidate(candidate: TokenCandidate): OpportunityScore {
  const reasons: string[] = [];
  const risks: string[] = [];
  let total = 0;

  // Liquidity — weighted more heavily than in fresh launch.
  // A migrated token with $50K+ liquidity is a strong signal; bonding curve
  // completion requires ~$69K raised, so $50K+ post-migration is the norm for
  // successful tokens, not an outlier.
  if (candidate.liquidityUsd >= 80_000) {
    total += 28;
    reasons.push('strong_migration_liquidity');
  } else if (candidate.liquidityUsd >= 40_000) {
    total += 20;
    reasons.push('liquidity_ok');
  } else if (candidate.liquidityUsd >= 15_000) {
    total += 10;
    reasons.push('low_migration_liquidity');
  } else {
    total -= 15;
    risks.push('insufficient_liquidity');
  }

  // Volume — 5-minute activity signals whether the migration pump is live.
  if (candidate.volume5mUsd >= 30_000) {
    total += 22;
    reasons.push('high_migration_volume');
  } else if (candidate.volume5mUsd >= 10_000) {
    total += 15;
    reasons.push('volume_ok');
  } else if (candidate.volume5mUsd >= 2_000) {
    total += 7;
    risks.push('low_5m_volume');
  } else {
    total -= 5;
    risks.push('very_low_5m_volume');
  }

  // Buy pressure — must be present immediately post-migration.
  const totalTrades = candidate.buys5m + candidate.sells5m;
  const buyRatio = totalTrades === 0 ? 0 : candidate.buys5m / totalTrades;
  if (buyRatio >= 0.65 && totalTrades >= 30) {
    total += 18;
    reasons.push('strong_buy_pressure');
  } else if (buyRatio >= 0.5 && totalTrades >= 10) {
    total += 10;
    reasons.push('balanced_flow');
  } else {
    total -= 5;
    risks.push('weak_buy_pressure');
  }

  // Age — more forgiving than fresh launch. Migration tokens are 30 min–6 h old
  // by design. Penalize only very old tokens where the migration pump has passed.
  if (candidate.ageMinutes <= 360) {
    total += 8;
    reasons.push('within_migration_window');
  } else if (candidate.ageMinutes <= 720) {
    total += 3;
    risks.push('older_migration');
  } else {
    total -= 8;
    risks.push('stale_migration');
  }

  // Price momentum — positive short-term momentum confirms migration demand.
  if (candidate.priceChange5mPct > 5 && candidate.priceChange5mPct <= 60) {
    total += 10;
    reasons.push('positive_migration_momentum');
  } else if (candidate.priceChange5mPct > 0) {
    total += 5;
    reasons.push('mild_momentum');
  } else if (candidate.priceChange5mPct > 60) {
    total += 2;
    risks.push('possibly_overextended');
  } else {
    total -= 5;
    risks.push('negative_momentum');
  }

  // Route availability — non-negotiable for execution.
  if (candidate.routeAvailable) {
    total += 14;
    reasons.push('route_available');
  } else {
    total -= 30;
    risks.push('no_route');
  }

  // Slippage.
  if (candidate.estimatedSlippageBps <= 200) {
    total += 5;
    reasons.push('low_slippage');
  } else if (candidate.estimatedSlippageBps > 500) {
    total -= 8;
    risks.push('high_slippage');
  }

  // Honeypot checks — same as fresh launch; a sell route is mandatory.
  if (candidate.sellRouteAvailable === false) {
    total -= 50;
    risks.push('no_sell_route');
  }

  if (candidate.mintAuthorityRevoked === false) {
    total -= 20;
    risks.push('mint_authority_held');
  } else if (candidate.mintAuthorityRevoked === true) {
    total += 5;
    reasons.push('mint_authority_revoked');
  }

  if (candidate.freezeAuthorityRevoked === false) {
    total -= 15;
    risks.push('freeze_authority_held');
  } else if (candidate.freezeAuthorityRevoked === true) {
    total += 3;
    reasons.push('freeze_authority_revoked');
  }

  const bounded = clampScore(total);
  const recommendation = bounded >= 70 ? 'paper_trade' : bounded >= 45 ? 'watch' : 'ignore';
  return { total: bounded, recommendation, reasons, risks };
}

// Sizing tiers for migration: sharper, faster trades so we size more uniformly.
// High conviction (85+) gets 1.25x; below threshold gets full size (migration
// quality filter is already strict enough that we don't want to discount much).
const SIZING_TIERS: Array<{ minScore: number; multiplier: number }> = [
  { minScore: 85, multiplier: 1.25 },
  { minScore: 0, multiplier: 1.0 },
];

function migrationSizeMultiplier(score: number): number {
  return SIZING_TIERS.find((tier) => score >= tier.minScore)?.multiplier ?? 1.0;
}

const DEFAULT_CONFIG: StrategyConfig = {
  minScoreToEnter: 70,
  // Tighter exit profile for migration pumps — these moves are faster and
  // shorter than fresh launches. Arm the trailing stop sooner and hold less time.
  exits: {
    stopLossPct: 18,       // slightly tighter hard floor
    takeProfitPct: 200,    // safety ceiling
    trailingStopPct: 12,   // tighter trail — migration pumps give back gains fast
    trailingArmPct: 15,    // arm sooner — migration moves start from the event
    maxHoldMinutes: 25,    // shorter horizon — capture the migration pump, then exit
  },
};

export function createMigrationStrategy(config: Partial<StrategyConfig> = {}): TradingStrategy {
  const merged: StrategyConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    exits: { ...DEFAULT_CONFIG.exits, ...config.exits },
  };
  return {
    id: MIGRATION_MOMENTUM_STRATEGY_ID,
    config: merged,
    acceptsEventType: (eventType) => eventType === 'migration',
    tagCandidate: (candidate) => ({ ...candidate, strategyId: candidate.strategyId ?? MIGRATION_MOMENTUM_STRATEGY_ID }),
    scoreCandidate: scoreMigrationCandidate,
    resolvePositionSizeUsd: (score, baseUsd) => baseUsd * migrationSizeMultiplier(score),
  };
}

export const migrationMomentumStrategy: TradingStrategy = createMigrationStrategy();
