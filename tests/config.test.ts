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
    base: {
      enabled: false,
      walletFile: './wallet/chain-ethereum.txt',
      rpcUrlEnv: 'BASE_RPC_URL',
      minLiquidityUsd: 15000,
      minVolume5mUsd: 7500,
      maxSlippageBps: 500,
    },
    ethereum: {
      enabled: false,
      walletFile: './wallet/chain-ethereum.txt',
      rpcUrlEnv: 'ETHEREUM_RPC_URL',
      minLiquidityUsd: 50000,
      minVolume5mUsd: 20000,
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
    takeProfitPct: 50,
    trailingStopPct: 20,
    maxHoldMinutes: 45,
  },
  scoring: {
    minimumScoreToEnter: 75,
  },
};

describe('config loading', () => {
  it('parses the multi-chain paper trading config', () => {
    const config = parseConfig(validConfig);

    expect(config.mode).toBe('paper');
    expect(config.chains.solana.enabled).toBe(true);
    expect(config.chains.base.enabled).toBe(false);
    expect(config.chains.ethereum.enabled).toBe(false);
    expect(config.paper.positionSizeUsd).toBe(25);
  });

  it('rejects live mode until explicitly implemented', () => {
    expect(() => parseConfig({ ...validConfig, mode: 'live' })).toThrow(/mode/i);
  });

  it('loads config.yaml from disk', () => {
    const config = loadConfigFromFile('config.yaml');

    expect(config.mode).toBe('paper');
    expect(config.chains.solana.walletFile).toBe('./wallet/chain-solana.txt');
  });

  it('accepts a paper-mode config without walletFile', () => {
    const { solana, base, ethereum } = validConfig.chains;
    const config = parseConfig({
      ...validConfig,
      chains: {
        solana: { ...solana, walletFile: undefined },
        base: { ...base, walletFile: undefined },
        ethereum: { ...ethereum, walletFile: undefined },
      },
    });

    expect(config.chains.solana.walletFile).toBeUndefined();
  });
});
