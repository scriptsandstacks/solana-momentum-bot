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
      confirmationCommitment: 'confirmed',
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

  it('creates a LiveBroker in live mode', () => {
    const broker = createExecutionBroker({ config: parseConfig({ ...baseConfig, mode: 'live' }), paper });

    expect(broker).toBeInstanceOf(LiveBroker);
    expect(broker.mode).toBe('live');
    // No initial cash (deps not wired) so capacity check fails on funds.
    expect(broker.canOpenPosition()).toMatchObject({ ok: false });
  });

  it('LiveBroker openPosition rejects (no funds in a freshly factory-created broker)', async () => {
    const broker = createExecutionBroker({ config: parseConfig({ ...baseConfig, mode: 'live' }), paper });
    // Factory-created LiveBroker has no initial cash — canOpenPosition blocks first.
    await expect(broker.openPosition({} as any, 80)).rejects.toThrow(/insufficient funds|deps are not configured/);
  });

  it('LiveBroker closePosition rejects on unknown position id', async () => {
    const broker = createExecutionBroker({ config: parseConfig({ ...baseConfig, mode: 'live' }), paper });
    await expect(broker.closePosition('pos-1', 0.01, 'stop_loss')).rejects.toThrow('unknown position');
  });
});
