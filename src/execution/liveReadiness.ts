import type { BotConfig } from '../config/schema.js';

export type LiveReadinessStatus = 'pass' | 'warn' | 'block';

export interface LiveReadinessCheck {
  status: LiveReadinessStatus;
  label: string;
  detail: string;
}

export interface LiveReadinessInput {
  config: BotConfig;
  env?: Record<string, string | undefined>;
  walletFileExists?: boolean;
  closedTrades: number;
  trackedOutcomes: number;
  liveBrokerImplemented?: boolean;
}

export interface LiveReadinessReport {
  checks: LiveReadinessCheck[];
  pass: number;
  warn: number;
  block: number;
  ready: boolean;
}

export function evaluateLiveReadiness(input: LiveReadinessInput): LiveReadinessReport {
  const env = input.env ?? {};
  const checks: LiveReadinessCheck[] = [];
  const solana = input.config.chains.solana;

  checks.push(
    input.liveBrokerImplemented
      ? pass('Live broker implementation', 'LiveBroker is available for execution.')
      : block('Live broker implementation', 'LiveBroker is not implemented yet; live mode must remain blocked.'),
  );

  checks.push(
    input.config.mode === 'paper'
      ? pass('Mode gate', 'Config is in paper mode while live execution is unavailable.')
      : warn('Mode gate', 'Config is set to live, but CLI run still blocks live execution until LiveBroker exists.'),
  );

  checks.push(
    solana.enabled
      ? pass('Solana enabled', 'Solana is enabled as the current supported trading chain.')
      : block('Solana enabled', 'Solana must be enabled before live trading can be considered.'),
  );

  if (!solana.rpcUrlEnv) {
    checks.push(block('Solana RPC', 'chains.solana.rpcUrlEnv is not configured.'));
  } else if (!env[solana.rpcUrlEnv]) {
    checks.push(block('Solana RPC', `${solana.rpcUrlEnv} is configured but not present in the environment.`));
  } else {
    checks.push(pass('Solana RPC', `${solana.rpcUrlEnv} is configured and present.`));
  }

  if (!solana.walletFile) {
    checks.push(block('Wallet file', 'chains.solana.walletFile is not configured. The readiness audit does not read private keys.'));
  } else if (!input.walletFileExists) {
    checks.push(block('Wallet file', `${solana.walletFile} does not exist. The readiness audit only checks presence, not contents.`));
  } else {
    checks.push(pass('Wallet file', `${solana.walletFile} exists. Contents were not read.`));
  }

  const sizePct = (input.config.paper.positionSizeUsd / input.config.paper.startingBalanceUsd) * 100;
  checks.push(
    sizePct <= 10
      ? pass('Position sizing', `Base size is ${sizePct.toFixed(1)}% of starting paper balance.`)
      : warn('Position sizing', `Base size is ${sizePct.toFixed(1)}% of starting paper balance; consider <=10% before live.`),
  );

  const dailyLossPct = (input.config.paper.maxDailyLossUsd / input.config.paper.startingBalanceUsd) * 100;
  checks.push(
    dailyLossPct <= 25
      ? pass('Daily loss limit', `Daily loss cap is ${dailyLossPct.toFixed(1)}% of starting paper balance.`)
      : warn('Daily loss limit', `Daily loss cap is ${dailyLossPct.toFixed(1)}% of starting paper balance; consider a tighter cap.`),
  );

  checks.push(
    input.config.fees.applyRouteSlippage && input.config.fees.swapFeeBps > 0
      ? pass('Paper cost model', 'Paper fills include route slippage and nonzero swap fees.')
      : warn('Paper cost model', 'Paper fills should model route slippage and nonzero fees before live calibration.'),
  );

  checks.push(
    input.closedTrades >= 50
      ? pass('Paper trade sample', `${input.closedTrades} closed paper trades recorded.`)
      : warn('Paper trade sample', `${input.closedTrades} closed paper trades recorded; more paper data improves calibration but does not block live mode.`),
  );

  checks.push(
    input.trackedOutcomes >= 100
      ? pass('Outcome sample', `${input.trackedOutcomes} tracked scored-candidate outcomes recorded.`)
      : warn('Outcome sample', `${input.trackedOutcomes} tracked outcomes recorded; 100+ gives better threshold tuning.`),
  );

  const counts = checks.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { pass: 0, warn: 0, block: 0 } as Record<LiveReadinessStatus, number>,
  );

  return {
    checks,
    pass: counts.pass,
    warn: counts.warn,
    block: counts.block,
    ready: counts.block === 0,
  };
}

export function renderLiveReadinessReport(report: LiveReadinessReport): string {
  const lines = [
    'Live Readiness Audit',
    `Status: ${report.ready ? 'READY' : 'NOT READY'}  pass=${report.pass} warn=${report.warn} block=${report.block}`,
    '',
  ];

  for (const check of report.checks) {
    lines.push(`  [${check.status.toUpperCase()}] ${check.label}`);
    lines.push(`    ${check.detail}`);
  }

  return `${lines.join('\n')}\n`;
}

function pass(label: string, detail: string): LiveReadinessCheck {
  return { status: 'pass', label, detail };
}

function warn(label: string, detail: string): LiveReadinessCheck {
  return { status: 'warn', label, detail };
}

function block(label: string, detail: string): LiveReadinessCheck {
  return { status: 'block', label, detail };
}
