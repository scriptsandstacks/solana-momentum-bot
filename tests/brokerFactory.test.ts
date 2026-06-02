import { describe, expect, it } from 'vitest';
import { createExecutionBroker } from '../src/execution/brokerFactory.js';
import { LiveBroker } from '../src/execution/liveBroker.js';
import { PaperBroker } from '../src/paper/paperBroker.js';
import { parseConfig } from '../src/config/loadConfig.js';

const baseConfig = {
  mode: 'paper',
  chains: {
    solana: {
      enabled: true,
      walletFile: './wallet/chain-solana.txt',
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
  fees: {
    swapFeeBps: 30,
    applyRouteSlippage: true,
  },
  scoring: {
    minimumScoreToEnter: 75,
  },
};

const paper = { startingBalanceUsd: 1000, positionSizeUsd: 25, maxOpenPositions: 3 };

describe('createExecutionBroker', () => {
  it('creates a PaperBroker in paper mode', () => {
    const broker = createExecutionBroker({ config: parseConfig(baseConfig), paper });

    expect(broker).toBeInstanceOf(PaperBroker);
    expect(broker.mode).toBe('paper');
  });

  it('creates the inert LiveBroker scaffold in live mode', () => {
    const broker = createExecutionBroker({ config: parseConfig({ ...baseConfig, mode: 'live' }), paper });

    expect(broker).toBeInstanceOf(LiveBroker);
    expect(broker.mode).toBe('live');
    expect(broker.canOpenPosition()).toMatchObject({ ok: false });
    expect(() => broker.openPosition({} as any, 80)).toThrow('LiveBroker execution is not implemented yet');
  });
});
