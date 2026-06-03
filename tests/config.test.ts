import { describe, expect, it } from 'vitest';
import { loadConfigFromFile, parseConfig } from '../src/config/loadConfig.js';

const validConfig = {
  mode: 'paper',
  chains: {
    solana: {
      enabled: true,
      walletFile: './wallet/chain-solana.txt',
      minLiquidityUsd: 10000,
      minVolume5mUsd: 5000,
      maxSlippageBps: 500,
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
    takeProfitPct: 50,
    trailingStopPct: 20,
    maxHoldMinutes: 45,
  },
  scoring: {
    minimumScoreToEnter: 75,
  },
};

describe('config loading', () => {
  it('parses the Solana paper trading config', () => {
    const config = parseConfig(validConfig);

    expect(config.mode).toBe('paper');
    expect(config.chains.solana.enabled).toBe(true);
    expect(config.paper.positionSizeUsd).toBe(25);
    expect(config.strategies.freshLaunchMomentum.minScoreToEnter).toBeUndefined();
  });

  it('accepts live mode in config (CLI guards against running it)', () => {
    const config = parseConfig({ ...validConfig, mode: 'live' });
    expect(config.mode).toBe('live');
  });

  it('loads config.yaml from disk', () => {
    const config = loadConfigFromFile('config.yaml');

    expect(config.mode).toBe('paper');
    expect(config.chains.solana.walletFile).toBe('./wallet/chain-solana.txt');
  });

  it('accepts a paper-mode config without walletFile', () => {
    const { solana } = validConfig.chains;
    const config = parseConfig({
      ...validConfig,
      chains: {
        solana: { ...solana, walletFile: undefined },
      },
    });

    expect(config.chains.solana.walletFile).toBeUndefined();
  });

  it('accepts strategy-specific entry and exit overrides', () => {
    const config = parseConfig({
      ...validConfig,
      strategies: {
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
      },
    });

    expect(config.strategies.freshLaunchMomentum.minScoreToEnter).toBe(80);
    expect(config.strategies.freshLaunchMomentum.exits?.maxHoldMinutes).toBe(45);
    expect(config.strategies.migrationMomentum.minScoreToEnter).toBe(72);
    expect(config.strategies.migrationMomentum.exits?.stopLossPct).toBe(16);
  });
});
