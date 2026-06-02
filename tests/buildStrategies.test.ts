import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/loadConfig.js';
import { buildStrategies, strategyThresholdMap } from '../src/strategies/buildStrategies.js';

function configWithStrategies(strategies: unknown) {
  return parseConfig({
    mode: 'paper',
    chains: {
      solana: {
        enabled: true,
        minLiquidityUsd: 10_000,
        minVolume5mUsd: 5_000,
        maxSlippageBps: 500,
      },
      base: {
        enabled: false,
        minLiquidityUsd: 15_000,
        minVolume5mUsd: 7_500,
        maxSlippageBps: 500,
      },
      ethereum: {
        enabled: false,
        minLiquidityUsd: 50_000,
        minVolume5mUsd: 20_000,
        maxSlippageBps: 300,
      },
    },
    paper: {
      startingBalanceUsd: 1000,
      positionSizeUsd: 25,
      maxOpenPositions: 3,
      maxDailyLossUsd: 100,
    },
    exits: {
      stopLossPct: 20,
      takeProfitPct: 300,
      trailingStopPct: 15,
      trailingArmPct: 30,
      maxHoldMinutes: 60,
    },
    scoring: {
      minimumScoreToEnter: 75,
    },
    strategies,
  });
}

describe('buildStrategies', () => {
  it('uses global fresh-launch threshold and migration default when no strategy overrides are provided', () => {
    const strategies = buildStrategies(configWithStrategies(undefined));

    expect(strategyThresholdMap(strategies)).toMatchObject({
      freshLaunchMomentum: 75,
      migrationMomentum: 70,
    });
  });

  it('applies per-strategy entry and exit overrides from config', () => {
    const strategies = buildStrategies(
      configWithStrategies({
        freshLaunchMomentum: {
          minScoreToEnter: 80,
          exits: {
            maxHoldMinutes: 45,
          },
        },
        migrationMomentum: {
          minScoreToEnter: 72,
          exits: {
            stopLossPct: 16,
          },
        },
      }),
    );

    const byId = new Map(strategies.map((strategy) => [strategy.id, strategy]));
    expect(byId.get('freshLaunchMomentum')?.config).toMatchObject({
      minScoreToEnter: 80,
      exits: {
        maxHoldMinutes: 45,
        trailingArmPct: 30,
      },
    });
    expect(byId.get('migrationMomentum')?.config).toMatchObject({
      minScoreToEnter: 72,
      exits: {
        stopLossPct: 16,
        maxHoldMinutes: 25,
      },
    });
  });
});
