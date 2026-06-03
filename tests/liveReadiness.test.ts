import { describe, expect, it } from 'vitest';
import { evaluateLiveReadiness, renderLiveReadinessReport } from '../src/execution/liveReadiness.js';
import type { BotConfig } from '../src/config/schema.js';

const config: BotConfig = {
  mode: 'paper',
  chains: {
    solana: {
      enabled: true,
      walletFile: './wallet/chain-solana.txt',
      rpcUrlEnv: 'SOLANA_RPC_URL',
      minLiquidityUsd: 10_000,
      minVolume5mUsd: 5_000,
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
  strategies: {
    freshLaunchMomentum: {},
    migrationMomentum: {},
  },
  retention: {
    scoredCandidateDays: 30,
  },
  notifications: {
    console: true,
  },
};

describe('evaluateLiveReadiness', () => {
  it('blocks live readiness while live execution is missing even when prerequisites are present', () => {
    const report = evaluateLiveReadiness({
      config,
      env: { SOLANA_RPC_URL: 'https://rpc.example' },
      walletFileExists: true,
      closedTrades: 60,
      trackedOutcomes: 120,
      liveBrokerAvailable: true,
    });

    expect(report.ready).toBe(false);
    expect(report.block).toBe(1);
    expect(report.checks.find((check) => check.label === 'Live broker scaffold')).toMatchObject({
      status: 'pass',
    });
    expect(report.checks.find((check) => check.label === 'Live execution implementation')).toMatchObject({
      status: 'block',
    });
    expect(renderLiveReadinessReport(report)).toContain('Live Readiness Audit');
  });

  it('flags missing RPC and wallet file as blockers, while paper sample is advisory', () => {
    const report = evaluateLiveReadiness({
      config: { ...config, chains: { ...config.chains, solana: { ...config.chains.solana, rpcUrlEnv: 'MISSING_RPC' } } },
      env: {},
      walletFileExists: false,
      closedTrades: 0,
      trackedOutcomes: 0,
    });

    expect(report.checks.find((check) => check.label === 'Solana RPC')).toMatchObject({ status: 'block' });
    expect(report.checks.find((check) => check.label === 'Wallet file')).toMatchObject({ status: 'block' });
    expect(report.checks.find((check) => check.label === 'Paper trade sample')).toMatchObject({ status: 'warn' });
    expect(report.warn).toBeGreaterThan(0);
  });

  it('does not block an owner solely because paper-trade samples are low', () => {
    const report = evaluateLiveReadiness({
      config,
      env: { SOLANA_RPC_URL: 'https://rpc.example' },
      walletFileExists: true,
      closedTrades: 0,
      trackedOutcomes: 0,
      liveBrokerAvailable: true,
      liveExecutionImplemented: true,
    });

    expect(report.ready).toBe(true);
    expect(report.block).toBe(0);
    expect(report.checks.find((check) => check.label === 'Paper trade sample')).toMatchObject({ status: 'warn' });
  });
});
