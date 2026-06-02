import type { BotConfig } from '../config/schema.js';
import { createFreshLaunchStrategy, FRESH_LAUNCH_MOMENTUM_STRATEGY_ID } from './freshLaunchMomentum.js';
import { createMigrationStrategy, MIGRATION_MOMENTUM_STRATEGY_ID } from './migrationMomentum.js';
import type { StrategyConfig, TradingStrategy } from './types.js';

type StrategyOverrides = NonNullable<BotConfig['strategies']>[keyof NonNullable<BotConfig['strategies']>];

export function buildStrategies(config: BotConfig): TradingStrategy[] {
  return [
    createFreshLaunchStrategy(
      strategyConfigOverrides(config.strategies?.freshLaunchMomentum, {
        minScoreToEnter: config.scoring.minimumScoreToEnter,
      }),
    ),
    createMigrationStrategy(strategyConfigOverrides(config.strategies?.migrationMomentum)),
  ];
}

export function strategyThresholdMap(strategies: TradingStrategy[]): Record<string, number> {
  return Object.fromEntries(strategies.map((strategy) => [strategy.id, strategy.config.minScoreToEnter]));
}

export const STRATEGY_CONFIG_PATHS = {
  [FRESH_LAUNCH_MOMENTUM_STRATEGY_ID]: ['strategies', FRESH_LAUNCH_MOMENTUM_STRATEGY_ID] as const,
  [MIGRATION_MOMENTUM_STRATEGY_ID]: ['strategies', MIGRATION_MOMENTUM_STRATEGY_ID] as const,
};

function strategyConfigOverrides(
  overrides: StrategyOverrides | undefined,
  defaults: Partial<StrategyConfig> = {},
): Partial<StrategyConfig> {
  const config: Partial<StrategyConfig> = { ...defaults };
  if (overrides?.minScoreToEnter !== undefined) {
    config.minScoreToEnter = overrides.minScoreToEnter;
  }
  if (overrides?.exits) {
    config.exits = overrides.exits;
  }
  return config;
}
