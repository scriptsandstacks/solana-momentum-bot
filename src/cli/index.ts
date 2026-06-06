import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { renderReport } from '../bot/report.js';
import { runPaperCycle } from '../bot/paperCycle.js';
import { renderStorageReport } from '../bot/storageReport.js';
import { computeTradeAnalytics, renderAnalyticsReport, computeOutcomeAnalytics, renderOutcomeAnalytics } from '../bot/analytics.js';
import { renderSnapshot } from '../bot/snapshot.js';
import { trackCandidateOutcomes } from '../bot/trackOutcomes.js';
import { runPumpWatch } from '../bot/pumpWatch.js';
import { processPumpPortalEvents } from '../bot/pumpProcess.js';
import { processExits } from '../bot/exitPositions.js';
import { runBotLoop } from '../bot/runLoop.js';
import { consoleReporter } from '../bot/reporter.js';
import { discordReporter } from '../bot/discordReporter.js';
import {
  applyTuneConfigUpdates,
  computeStrategyTuneRecommendations,
  computeTuneRecommendations,
  deriveTuneConfigUpdates,
  renderStrategyTuneReport,
  renderTuneApplyPreview,
  renderTuneReport,
} from '../bot/tune.js';
import { loadConfigFromFile } from '../config/loadConfig.js';
import { scanSolanaCandidates } from '../chains/solana/scanner.js';
import { checkJupiterRoute } from '../discovery/jupiter.js';
import { PaperBroker } from '../paper/paperBroker.js';
import { scoreTokenCandidate } from '../scoring/scoreToken.js';
import { SqliteStore } from '../storage/sqliteStore.js';
import { buildStrategies, strategyThresholdMap } from '../strategies/buildStrategies.js';
import { DEFAULT_MIN_SOL_FEE_RESERVE_LAMPORTS, evaluateLiveReadiness, renderLiveReadinessReport } from '../execution/liveReadiness.js';
import { LiveBroker } from '../execution/liveBroker.js';
import { loadSolanaKeypair, createLiveBrokerDeps, queryWalletCashInventory, queryWalletCashUsd } from '../execution/liveDeps.js';
import { TokenActivityWatcher, rpcUrlToWs } from '../execution/tokenActivityWatcher.js';
import { reconcileWalletPositions, renderReconciliationReport } from '../execution/walletReconciler.js';
import {
  buildStaleRecovery,
  buildOrphanedRecovery,
  renderRecoveryPlan,
  renderRecoverySummary,
  RECOVERY_STRATEGY_ID,
} from '../execution/positionRecovery.js';
import {
  findMostRecentWalletBuy,
  recoveredBuyEntryPriceUsd,
  SOL_MINT,
} from '../execution/solanaTransactionHistory.js';
import {
  inspectSubmittedLiveExecution,
  renderIncompleteLiveExecutions,
} from '../execution/liveExecutionJournal.js';
import { fetchPumpPortalMarketCandidates } from '../bot/pumpCandidates.js';
import type { ExitRules } from '../bot/exitPositions.js';
import type { TradingStrategy } from '../strategies/types.js';
import type { PaperBrokerOptions } from '../paper/paperBroker.js';
import type { BotConfig } from '../config/schema.js';

// Build the broker options shared by every real-trading command, including the
// daily-loss breaker and the trading-cost model so paper fills carry realistic
// slippage + fees.
function paperBrokerOptions(config: BotConfig): PaperBrokerOptions {
  return {
    startingBalanceUsd: config.paper.startingBalanceUsd,
    positionSizeUsd: config.paper.positionSizeUsd,
    maxOpenPositions: config.paper.maxOpenPositions,
    maxDailyLossUsd: config.paper.maxDailyLossUsd,
    costModel: {
      feeBps: config.fees.swapFeeBps,
      applyRouteSlippage: config.fees.applyRouteSlippage,
    },
  };
}

function solanaRpcRequest(rpcUrl: string): (method: string, params: unknown[]) => Promise<unknown> {
  return async (method, params) => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Solana RPC ${method} failed: ${res.status} ${res.statusText}`);
    const json = await res.json() as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(`Solana RPC ${method}: ${json.error.message}`);
    return json.result;
  };
}

async function buildLiveBrokerIfNeeded(
  config: BotConfig,
  store: { loadOpenPositions(): any; getRealizedPnlUsd(): number; getRealizedPnlUsdSince(s: string): number; getNextPositionSeq(): number },
): Promise<LiveBroker | undefined> {
  if (config.mode !== 'live') return undefined;

  const solana = config.chains.solana;
  if (!solana.walletFile) throw new Error('chains.solana.walletFile must be set for live mode');
  const rpcUrl = solana.rpcUrlEnv ? process.env[solana.rpcUrlEnv] : undefined;
  if (!rpcUrl) throw new Error(`Solana RPC URL env var "${solana.rpcUrlEnv ?? 'rpcUrlEnv'}" is not set or not configured`);

  const keypair = loadSolanaKeypair(solana.walletFile);
  const deps = createLiveBrokerDeps(keypair, {
    rpcUrl,
    maxSlippageBps: solana.maxSlippageBps,
    confirmationCommitment: solana.confirmationCommitment,
    priorityFeeLamports: solana.priorityFeeLamports ?? 'auto',
  });

  const initialCashUsd = await queryWalletCashUsd(keypair.publicKey.toBase58(), deps, solanaRpcRequest(rpcUrl));

  const brokerOptions = {
    solana,
    positionSizeUsd: config.paper.positionSizeUsd,
    maxOpenPositions: config.paper.maxOpenPositions,
    maxDailyLossUsd: config.paper.maxDailyLossUsd,
  };

  return LiveBroker.restore(store, brokerOptions, deps, initialCashUsd);
}

// Build a per-position exit resolver that merges each strategy's exit overrides
// over the global exits. Keyed by strategyId so any number of strategies can
// define their own thresholds without touching each other's positions.
function buildExitResolver(strategies: TradingStrategy[], globalExits: ExitRules) {
  const byId = new Map(strategies.map((s) => [s.id, s]));
  return (strategyId: string | undefined): ExitRules | undefined => {
    const strategy = strategyId ? byId.get(strategyId) : undefined;
    if (!strategy?.config.exits) return undefined; // fall back to global exits
    return {
      stopLossPct: strategy.config.exits.stopLossPct ?? globalExits.stopLossPct,
      takeProfitPct: strategy.config.exits.takeProfitPct ?? globalExits.takeProfitPct,
      trailingStopPct: strategy.config.exits.trailingStopPct ?? globalExits.trailingStopPct,
      trailingArmPct: strategy.config.exits.trailingArmPct ?? globalExits.trailingArmPct,
      maxHoldMinutes: strategy.config.exits.maxHoldMinutes ?? globalExits.maxHoldMinutes,
    };
  };
}

const program = new Command();

program
  .name('solana-trade-engine')
  .description('Solana memecoin trading bot with paper and live execution')
  .option('-c, --config <path>', 'config file path', 'config.yaml');

program.command('scan').description('Scan Solana and print scored candidates').action(async () => {
  const config = loadConfigFromFile(program.opts().config);
  const store = new SqliteStore();
  const candidates = config.chains.solana.enabled ? await scanSolanaCandidates(config.chains.solana) : [];
  const scored = candidates.map((candidate) => ({ candidate, score: scoreTokenCandidate(candidate) }));
  for (const { candidate, score } of scored) {
    store.saveScoredCandidate(candidate, score);
  }
  const broker = new PaperBroker({
    startingBalanceUsd: config.paper.startingBalanceUsd,
    positionSizeUsd: config.paper.positionSizeUsd,
    maxOpenPositions: config.paper.maxOpenPositions,
  });

  process.stdout.write(
    renderReport({
      candidates: scored,
      cashUsd: broker.getCashUsd(),
      openPositions: broker.getOpenPositions().length,
      closedTrades: broker.getClosedTrades().length,
    }),
  );
  store.close();
});

program
  .command('check-route')
  .description('Smoke-test a Jupiter route for one token mint (read-only quote; no trade)')
  .argument('<mint>', 'output token mint to quote a swap into')
  .action(async (mint: string) => {
    const usingKey = Boolean(process.env.JUPITER_API_KEY);
    process.stdout.write(`Checking Jupiter route for ${mint} (host=${usingKey ? 'api.jup.ag (keyed)' : 'lite-api.jup.ag (keyless)'})...\n`);
    const route = await checkJupiterRoute(mint);
    if (route.routeAvailable) {
      process.stdout.write(
        `Route available via ${route.routeInputSymbol} (${route.routeInputMint}); estimatedSlippage=${route.estimatedSlippageBps}bps\n`,
      );
    } else {
      process.stdout.write('No buy route available (token may be unswappable, illiquid, or the quote API is unreachable).\n');
    }
    process.stdout.write(`Sell route (token→USDC): ${route.sellRouteAvailable ? 'available' : 'UNAVAILABLE — possible honeypot'}\n`);
  });

program
  .command('live-readiness')
  .description('Audit live-trading prerequisites without reading wallet contents or placing trades')
  .action(() => {
    const config = loadConfigFromFile(program.opts().config);
    const store = new SqliteStore();
    try {
      const walletFile = config.chains.solana.walletFile;
      const walletFileExists = walletFile ? fs.existsSync(path.resolve(process.cwd(), walletFile)) : false;
      const report = evaluateLiveReadiness({
        config,
        env: process.env,
        walletFileExists,
        closedTrades: store.loadClosedTradeStats().length,
        trackedOutcomes: store.loadScoredOutcomeStats().length,
        liveBrokerAvailable: true,
        liveExecutionImplemented: true,
      });
      process.stdout.write(renderLiveReadinessReport(report));
    } finally {
      store.close();
    }
  });

program
  .command('wallet-balances')
  .description('Read live wallet route-input balances without placing trades')
  .action(async () => {
    const config = loadConfigFromFile(program.opts().config);
    const solana = config.chains.solana;
    if (!solana.walletFile) throw new Error('chains.solana.walletFile must be set to inspect wallet balances.');
    const rpcUrl = solana.rpcUrlEnv ? process.env[solana.rpcUrlEnv] : undefined;
    if (!rpcUrl) throw new Error(`Solana RPC URL env var "${solana.rpcUrlEnv ?? 'rpcUrlEnv'}" is not set or not configured.`);

    const keypair = loadSolanaKeypair(solana.walletFile);
    const deps = createLiveBrokerDeps(keypair, {
      rpcUrl,
      maxSlippageBps: solana.maxSlippageBps,
      confirmationCommitment: solana.confirmationCommitment,
      priorityFeeLamports: solana.priorityFeeLamports ?? 'auto',
    });
    const inventory = await queryWalletCashInventory(keypair.publicKey.toBase58(), deps, solanaRpcRequest(rpcUrl));
    const minReserve = BigInt(solana.minSolFeeReserveLamports ?? DEFAULT_MIN_SOL_FEE_RESERVE_LAMPORTS);
    const reserveStatus = inventory.solLamports >= minReserve ? 'OK' : 'LOW';

    process.stdout.write([
      'Live Wallet Balances',
      `Wallet: ${inventory.publicKey}`,
      `SOL: ${inventory.sol.toFixed(6)} ($${inventory.solUsd.toFixed(2)} at $${inventory.solPriceUsd.toFixed(2)}/SOL)`,
      `USDC: ${inventory.usdc.toFixed(2)}`,
      `USDT: ${inventory.usdt.toFixed(2)}`,
      `Total route-input value: $${inventory.totalUsd.toFixed(2)}`,
      `SOL fee reserve: ${reserveStatus} (${inventory.solLamports.toString()} / ${minReserve.toString()} lamports)`,
      '',
    ].join('\n'));
  });

program
  .command('journal')
  .description('List submitted or confirmed live executions that still require reconciliation')
  .action(() => {
    const store = new SqliteStore();
    try {
      const report = renderIncompleteLiveExecutions(store.listIncompleteLiveExecutions());
      process.stdout.write(report ? `${report}\n` : 'No incomplete live executions.\n');
    } finally {
      store.close();
    }
  });

program
  .command('journal-resolve')
  .description('Resolve an RPC-proven failed or expired submitted live execution')
  .argument('<id>', 'live execution journal id')
  .option('--yes', 'resolve without interactive confirmation', false)
  .action(async (id: string, options: { yes: boolean }) => {
    const config = loadConfigFromFile(program.opts().config);
    const solana = config.chains.solana;
    const rpcUrl = solana.rpcUrlEnv ? process.env[solana.rpcUrlEnv] : undefined;
    if (!rpcUrl) {
      throw new Error(`Solana RPC URL env var "${solana.rpcUrlEnv ?? 'rpcUrlEnv'}" is not set.`);
    }

    const store = new SqliteStore();
    try {
      const entry = store.getLiveExecutionJournalEntry(id);
      if (!entry) throw new Error(`No live execution journal entry found for "${id}".`);

      const resolution = await inspectSubmittedLiveExecution({ entry, rpcUrl });
      process.stdout.write(`${resolution.reason}\n`);
      if (!resolution.resolvable) return;

      if (!options.yes) {
        if (!process.stdin.isTTY) {
          throw new Error('Non-interactive shell — re-run with --yes to resolve this journal entry.');
        }
        const rl = createInterface({ input, output });
        try {
          const answer = await rl.question(`Mark journal entry "${id}" failed? Type "yes" to continue: `);
          if (answer.trim().toLowerCase() !== 'yes') {
            process.stdout.write('No changes applied.\n');
            return;
          }
        } finally {
          rl.close();
        }
      }

      store.recordLiveExecutionFailed(id, resolution.reason);
      process.stdout.write(`Resolved journal entry "${id}" as failed.\n`);
    } finally {
      store.close();
    }
  });

program.command('paper').description('Run one paper-trading scan cycle').action(async () => {
  const config = loadConfigFromFile(program.opts().config);
  const store = new SqliteStore();
  const candidates = config.chains.solana.enabled ? await scanSolanaCandidates(config.chains.solana) : [];
  const { broker, scored } = await runPaperCycle({
    candidates,
    paper: paperBrokerOptions(config),
    minimumScoreToEnter: config.scoring.minimumScoreToEnter,
    store,
  });

  process.stdout.write(
    renderReport({
      candidates: scored,
      cashUsd: broker.getCashUsd(),
      openPositions: broker.getOpenPositions().length,
      closedTrades: broker.getClosedTrades().length,
    }),
  );
  store.close();
});

program.command('report').description('Print persisted scan, position, and trade summary').action(() => {
  const store = new SqliteStore();
  process.stdout.write(
    renderStorageReport({
      recentScores: store.listRecentScores(20),
      openPositions: store.listOpenPositions(),
      closedTrades: store.listClosedTrades(20),
      pumpPortalEvents: store.listPumpPortalEvents(20),
    }),
  );
  store.close();
});

program
  .command('stats')
  .description('Aggregate trade performance: expectancy, win rate, and PnL by reason / score / source / strategy')
  .action(() => {
    const store = new SqliteStore();
    const analytics = computeTradeAnalytics(store.loadClosedTradeStats());
    process.stdout.write(renderAnalyticsReport(analytics));
    store.close();
  });

program
  .command('strategies')
  .description('Per-strategy performance summary: trades, win rate, expectancy, and P&L')
  .action(() => {
    const store = new SqliteStore();
    const trades = store.loadClosedTradeStats();
    if (trades.length === 0) {
      process.stdout.write('No closed trades yet — run the bot to accumulate paper results.\n');
      store.close();
      return;
    }
    const analytics = computeTradeAnalytics(trades);
    const lines = [
      'Strategy Performance Summary',
      `Total trades: ${analytics.overall.trades}  Total P&L: $${analytics.overall.totalPnlUsd.toFixed(2)}`,
      '',
      'Per-strategy breakdown:',
    ];
    for (const bucket of analytics.byStrategy) {
      const pf = bucket.profitFactor === Number.POSITIVE_INFINITY ? 'inf' : bucket.profitFactor.toFixed(2);
      lines.push(
        `  ${bucket.label.padEnd(28)}` +
          ` trades=${String(bucket.trades).padStart(4)}` +
          ` win%=${bucket.winRatePct.toFixed(1).padStart(5)}` +
          ` pnl=$${bucket.totalPnlUsd.toFixed(2).padStart(8)}` +
          ` exp=$${bucket.expectancyUsd.toFixed(2).padStart(7)}` +
          ` pf=${pf.padStart(5)}` +
          ` hold=${bucket.avgHoldMinutes.toFixed(1)}m`,
      );
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    store.close();
  });

program
  .command('track-outcomes')
  .description('Re-price recently scored candidates to capture forward MFE/MAE for threshold tuning')
  .option('--limit <limit>', 'maximum candidates to re-price this pass', '200')
  .action(async (options: { limit: string }) => {
    const limit = Number(options.limit);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error('--limit must be a positive number');
    }
    const config = loadConfigFromFile(program.opts().config);
    const store = new SqliteStore();
    const result = await trackCandidateOutcomes({
      store,
      horizonMinutes: config.exits.maxHoldMinutes,
      thresholds: { takeProfitPct: config.exits.takeProfitPct, stopLossPct: config.exits.stopLossPct },
      limit,
    });
    store.close();
    process.stdout.write(
      `Outcome tracking complete. finalized=${result.finalized} tracked=${result.tracked} updated=${result.updated} completed=${result.completed} noPrice=${result.missingPrice}\n`,
    );
  });

program
  .command('outcomes')
  .description('Counterfactual analytics: forward MFE/MAE of scored candidates by score bucket')
  .action(() => {
    const config = loadConfigFromFile(program.opts().config);
    const store = new SqliteStore();
    const thresholds = { takeProfitPct: config.exits.takeProfitPct, stopLossPct: config.exits.stopLossPct };
    const analytics = computeOutcomeAnalytics(store.loadScoredOutcomeStats(), thresholds);
    process.stdout.write(renderOutcomeAnalytics(analytics, thresholds));
    store.close();
  });

program
  .command('tune')
  .description('Analyze outcome data and recommend adjustments to entry threshold and exit parameters')
  .option('--apply', 'write concrete recommendations back to the config file after confirmation', false)
  .option('--yes', 'skip confirmation when used with --apply', false)
  .action(async (options: { apply: boolean; yes: boolean }) => {
    const configPath = path.resolve(process.cwd(), program.opts().config);
    const config = loadConfigFromFile(configPath);
    const store = new SqliteStore();
    const thresholds = { takeProfitPct: config.exits.takeProfitPct, stopLossPct: config.exits.stopLossPct };
    const outcomeRows = store.loadScoredOutcomeStats();
    store.close();

    if (outcomeRows.length === 0) {
      process.stdout.write(
        'No outcome data yet.\nRun the bot with `run` or `track-outcomes` to accumulate forward price data, then re-run `tune`.\n',
      );
      return;
    }

    const analytics = computeOutcomeAnalytics(outcomeRows, thresholds);
    const result = computeTuneRecommendations(analytics, thresholds, config.scoring.minimumScoreToEnter);
    process.stdout.write(renderTuneReport(result, analytics, thresholds, config.scoring.minimumScoreToEnter));
    const strategies = buildStrategies(config);
    const strategyResults = computeStrategyTuneRecommendations(
      outcomeRows,
      thresholds,
      strategyThresholdMap(strategies),
    );
    process.stdout.write(renderStrategyTuneReport(strategyResults, thresholds));

    if (!options.apply) return;

    const updates = deriveTuneConfigUpdates([
      ...result.recommendations,
      ...strategyResults.flatMap((strategy) => strategy.result.recommendations),
    ]);
    process.stdout.write(`\n${renderTuneApplyPreview(updates)}`);
    if (updates.length === 0) return;

    if (!options.yes) {
      if (!process.stdin.isTTY) {
        throw new Error('Cannot confirm --apply in a non-interactive shell. Re-run with --yes to apply concrete recommendations.');
      }
      const rl = createInterface({ input, output });
      try {
        const answer = await rl.question(`Apply ${updates.length} update(s) to ${configPath}? Type "yes" to continue: `);
        if (answer.trim().toLowerCase() !== 'yes') {
          process.stdout.write('No changes applied.\n');
          return;
        }
      } finally {
        rl.close();
      }
    }

    const currentText = fs.readFileSync(configPath, 'utf8');
    const updatedText = applyTuneConfigUpdates(currentText, updates);
    fs.writeFileSync(configPath, updatedText);
    process.stdout.write(`Applied ${updates.length} config update(s) to ${configPath}.\n`);
  });

program
  .command('recover-positions')
  .description('Detect and fix wallet/SQLite discrepancies: close stale positions and register orphaned on-chain holdings')
  .option('--dry-run', 'show recovery plan without writing to SQLite', false)
  .option('--yes', 'apply all recoveries without interactive confirmation', false)
  .action(async (options: { dryRun: boolean; yes: boolean }) => {
    const config = loadConfigFromFile(program.opts().config);
    const solana = config.chains.solana;

    if (!solana.walletFile) {
      throw new Error('chains.solana.walletFile must be configured to run recovery.');
    }
    const rpcUrl = solana.rpcUrlEnv ? process.env[solana.rpcUrlEnv] : undefined;
    if (!rpcUrl) {
      throw new Error(`Solana RPC URL env var "${solana.rpcUrlEnv ?? 'rpcUrlEnv'}" is not set.`);
    }

    const keypair = loadSolanaKeypair(solana.walletFile);
    const walletPublicKey = keypair.publicKey.toBase58();

    const store = new SqliteStore();
    try {
      const openPositions = store.loadOpenPositions();
      const incompleteExecutions = store.listIncompleteLiveExecutions();
      process.stdout.write(`Querying on-chain balances for wallet ${walletPublicKey}...\n`);
      const journalReport = renderIncompleteLiveExecutions(incompleteExecutions);
      if (journalReport) process.stdout.write(`${journalReport}\n`);

      const reconciliation = await reconcileWalletPositions({ walletPublicKey, openPositions, rpcUrl });

      if (reconciliation.error) {
        process.stdout.write(`${renderReconciliationReport(reconciliation)}\n`);
        process.stdout.write('Cannot proceed with recovery — fix RPC connectivity and retry.\n');
        return;
      }

      process.stdout.write(renderReconciliationReport(reconciliation));
      if (reconciliation.orphaned.length === 0 && reconciliation.stale.length === 0) {
        process.stdout.write('\n');
        return;
      }
      process.stdout.write('\n');

      // ── build recovery plan ─────────────────────────────────────────────
      const staleRecoveries = reconciliation.stale.map((s) => {
        const pos = openPositions.find((p) => p.id === s.positionId)!;
        const recovery = buildStaleRecovery(pos);
        const journalClose = incompleteExecutions.find(
          (entry) => entry.side === 'close' && entry.positionId === s.positionId && entry.signature,
        );
        if (journalClose?.signature) recovery.trade.exitTxSignature = journalClose.signature;
        return recovery;
      });

      // Fetch market prices for orphaned holdings.
      const orphanedMints = reconciliation.orphaned.map((h) => h.mint);
      const marketCandidates = orphanedMints.length > 0
        ? await fetchPumpPortalMarketCandidates(orphanedMints)
        : [];
      const candidateByMint = new Map(marketCandidates.map((c) => [c.address, c]));
      const recoveryDeps = createLiveBrokerDeps(keypair, {
        rpcUrl,
        maxSlippageBps: solana.maxSlippageBps,
        confirmationCommitment: solana.confirmationCommitment,
        priorityFeeLamports: solana.priorityFeeLamports ?? 'auto',
      });

      let nextSeq = store.getNextPositionSeq();
      const orphanedRecoveries = await Promise.all(reconciliation.orphaned.map(async (h) => {
        const candidate = candidateByMint.get(h.mint);
        const positionId = `live-${nextSeq++}`;
        try {
          const buy = await findMostRecentWalletBuy({
            walletPublicKey,
            outputMint: h.mint,
            rpcUrl,
          });
          if (buy) {
            const decimals = await recoveryDeps.getTokenDecimals(h.mint);
            const solPriceUsd = buy.inputMint === SOL_MINT ? await recoveryDeps.getSolPriceUsd() : undefined;
            const entryPriceUsd = recoveredBuyEntryPriceUsd(buy, decimals, solPriceUsd);
            if (entryPriceUsd !== undefined) {
              let entryNetworkFeeUsd: number | undefined;
              try {
                entryNetworkFeeUsd = (buy.networkFeeLamports / 1e9) * await recoveryDeps.getSolPriceUsd();
              } catch {
                // Raw lamports are still preserved when SOL/USD is unavailable.
              }
              return buildOrphanedRecovery(h, candidate, positionId, new Date(), {
                buy,
                entryPriceUsd,
                entryPriceSource: buy.inputMint === SOL_MINT ? 'transaction_history_approx' : 'transaction_history',
                entryNetworkFeeUsd,
              });
            }
          }
        } catch {
          // Recovery remains useful when history is unavailable or pruned.
        }
        return buildOrphanedRecovery(h, candidate, positionId);
      }));

      // ── show plan ───────────────────────────────────────────────────────
      const plan = renderRecoveryPlan(staleRecoveries, orphanedRecoveries);
      process.stdout.write(`${plan}\n`);

      const actionable = [
        ...staleRecoveries,
        ...orphanedRecoveries.filter((r) => r.currentPriceUsd !== undefined),
      ];
      const skipped = orphanedRecoveries.filter((r) => r.currentPriceUsd === undefined).length;

      if (actionable.length === 0) {
        process.stdout.write(renderRecoverySummary(0, 0, skipped));
        process.stdout.write('\n');
        return;
      }

      if (options.dryRun) {
        process.stdout.write(`Dry run — no changes written.\n`);
        return;
      }

      // ── confirm ─────────────────────────────────────────────────────────
      if (!options.yes) {
        if (!process.stdin.isTTY) {
          throw new Error('Non-interactive shell — re-run with --yes to apply recoveries.');
        }
        const rl = createInterface({ input, output });
        try {
          const answer = await rl.question(
            `Apply ${actionable.length} recovery(s)? This modifies SQLite. Type "yes" to continue: `,
          );
          if (answer.trim().toLowerCase() !== 'yes') {
            process.stdout.write('No changes applied.\n');
            return;
          }
        } finally {
          rl.close();
        }
      }

      // ── execute ─────────────────────────────────────────────────────────
      let staleDone = 0;
      let orphanedDone = 0;

      for (const r of staleRecoveries) {
        store.saveClosedTrade(r.trade);
        staleDone += 1;
        process.stdout.write(
          `  Closed stale: ${r.position.id} ${r.position.token.symbol} pnl=$${r.pnlUsd.toFixed(4)}\n`,
        );
      }

      for (const r of orphanedRecoveries) {
        if (r.currentPriceUsd === undefined) continue;
        // Tag as the default strategy — operator can re-assign via a future command if needed.
        r.position.token.strategyId = r.position.token.strategyId ?? RECOVERY_STRATEGY_ID;
        store.saveOpenPosition(r.position);
        orphanedDone += 1;
        process.stdout.write(
          `  Registered orphan: ${r.position.id} ${r.position.token.symbol} qty=${r.position.quantity.toFixed(4)} entry=$${r.position.entryPriceUsd.toFixed(6)}\n`,
        );
      }

      process.stdout.write(`\n${renderRecoverySummary(staleDone, orphanedDone, skipped)}\n`);
    } finally {
      store.close();
    }
  });

program
  .command('prune')
  .description('Delete old data to reclaim disk: scored candidates, volume snapshots, and processed PumpPortal events')
  .option('--days <days>', 'scored-candidate retention in days; defaults to config retention.scoredCandidateDays')
  .option('--dry-run', 'report what would be deleted without deleting', false)
  .option('--no-vacuum', 'skip reclaiming disk with VACUUM after deleting')
  .action(async (options: { days?: string; dryRun: boolean; vacuum: boolean }) => {
    const config = loadConfigFromFile(program.opts().config);
    const candidateDays = options.days === undefined ? config.retention.scoredCandidateDays : Number(options.days);
    if (!Number.isFinite(candidateDays) || candidateDays <= 0) {
      throw new Error('--days must be a positive number');
    }
    const now = Date.now();
    const candidateCutoff = new Date(now - candidateDays * 864e5).toISOString();
    const eventCutoff = new Date(now - config.retention.pumpPortalEventDays * 864e5).toISOString();
    const snapshotCutoff = new Date(now - config.retention.volumeSnapshotDays * 864e5).toISOString();

    const store = new SqliteStore();
    try {
      if (options.dryRun) {
        const prunable = store.countPrunableScoredCandidates(candidateCutoff);
        process.stdout.write([
          `Dry run (no changes written):`,
          `  scored candidates  : ${prunable} rows older than ${candidateDays}d`,
          `  pumpportal events  : rows older than ${config.retention.pumpPortalEventDays}d (processed only)`,
          `  volume snapshots   : rows older than ${config.retention.volumeSnapshotDays}d`,
        ].join('\n') + '\n');
        return;
      }

      const candidates = store.pruneScoredCandidates(candidateCutoff);
      const events = store.prunePumpPortalEvents(eventCutoff);
      const snapshots = store.pruneTokenVolumeSnapshots(snapshotCutoff);
      const total = candidates + events + snapshots;

      if (total > 0 && options.vacuum) store.vacuum();
      const reclaimed = total > 0 && options.vacuum ? ' (disk reclaimed with VACUUM)' : '';
      process.stdout.write([
        `Prune complete${reclaimed}:`,
        `  scored candidates  : ${candidates} deleted (>${candidateDays}d)`,
        `  pumpportal events  : ${events} deleted (>${config.retention.pumpPortalEventDays}d, processed only)`,
        `  volume snapshots   : ${snapshots} deleted (>${config.retention.volumeSnapshotDays}d)`,
      ].join('\n') + '\n');
    } finally {
      store.close();
    }
  });

program
  .command('pump-watch')
  .description('Watch free PumpPortal new-token and migration streams for a bounded duration')
  .option('--api-key <key>', 'PumpPortal API key; defaults to PUMPPORTAL_API_KEY')
  .option('--seconds <seconds>', 'watch duration in seconds', '30')
  .action(async (options: { apiKey?: string; seconds: string }) => {
    const seconds = Number(options.seconds);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error('--seconds must be a positive number');
    }
    const store = new SqliteStore();
    const result = await runPumpWatch({
      apiKey: options.apiKey,
      durationMs: seconds * 1000,
      store,
      onLog: (message) => process.stdout.write(`${message}\n`),
    });
    store.close();
    process.stdout.write(`PumpPortal watch complete. Events saved: ${result.eventsSaved}\n`);
  });

program
  .command('pump-process')
  .description('Process pending PumpPortal events into enriched/scored paper candidates')
  .option('--limit <limit>', 'maximum pending PumpPortal events to process', '50')
  .action(async (options: { limit: string }) => {
    const limit = Number(options.limit);
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error('--limit must be a positive number');
    }
    const config = loadConfigFromFile(program.opts().config);
    if (!config.chains.solana.enabled) {
      throw new Error('Solana must be enabled to process PumpPortal events.');
    }
    const store = new SqliteStore();
    const result = await processPumpPortalEvents({
      store,
      solanaConfig: config.chains.solana,
      paper: paperBrokerOptions(config),
      minimumScoreToEnter: config.scoring.minimumScoreToEnter,
      limit,
    });
    store.close();
    process.stdout.write(
      `PumpPortal process complete. events=${result.eventsRead} enriched=${result.candidatesEnriched} scored=${result.scored} opened=${result.openedPositions} skipped=${result.skipped} failed=${result.failed}\n`,
    );
  });

program
  .command('manage-exits')
  .description('Re-price open paper positions and apply stop-loss / take-profit / trailing-stop / max-hold exits')
  .action(async () => {
    const config = loadConfigFromFile(program.opts().config);
    const strategies = buildStrategies(config);
    const store = new SqliteStore();
    const result = await processExits({
      store,
      paper: paperBrokerOptions(config),
      exits: config.exits,
      resolveExits: buildExitResolver(strategies, config.exits),
    });
    store.close();
    process.stdout.write(
      `Exit pass complete. checked=${result.positionsChecked} repriced=${result.repriced} closed=${result.closed} stopLoss=${result.stopLoss} takeProfit=${result.takeProfit} trailingStop=${result.trailingStop} timeout=${result.timeout} noPrice=${result.missingPrice}\n`,
    );
  });

program
  .command('run')
  .description('Continuously watch PumpPortal, process candidates, and manage paper or live positions')
  .option('--api-key <key>', 'PumpPortal API key; defaults to PUMPPORTAL_API_KEY')
  .option('--process-interval-seconds <seconds>', 'seconds between PumpPortal processing passes', '30')
  .option('--exit-interval-seconds <seconds>', 'seconds between exit-only passes in live mode (default: 10 in live, disabled in paper)')
  .option('--process-limit <limit>', 'maximum pending PumpPortal events per processing pass', '50')
  .option('--analytics-every <passes>', 'emit full analytics summary every N passes (0=off)', '10')
  .option('--seconds <seconds>', 'optional bounded runtime in seconds; omit to run until Ctrl-C')
  .action(async (options: { apiKey?: string; processIntervalSeconds: string; exitIntervalSeconds?: string; processLimit: string; analyticsEvery: string; seconds?: string }) => {
    const processIntervalSeconds = Number(options.processIntervalSeconds);
    const processLimit = Number(options.processLimit);
    const analyticsIntervalPasses = Number(options.analyticsEvery);
    const seconds = options.seconds === undefined ? undefined : Number(options.seconds);
    if (!Number.isFinite(processIntervalSeconds) || processIntervalSeconds <= 0) {
      throw new Error('--process-interval-seconds must be a positive number');
    }
    if (!Number.isFinite(processLimit) || processLimit <= 0) {
      throw new Error('--process-limit must be a positive number');
    }
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
      throw new Error('--seconds must be a positive number when provided');
    }

    const config = loadConfigFromFile(program.opts().config);
    if (!config.chains.solana.enabled) {
      throw new Error('Solana must be enabled to run the bot.');
    }

    const strategies = buildStrategies(config);
    const log = (message: string) => process.stdout.write(`${message}\n`);

    const reporters: import('../bot/reporter.js').Reporter[] = [];
    if (config.notifications.console) reporters.push(consoleReporter(log));

    const discordWebhookEnv = config.notifications.discordWebhookUrlEnv;
    const discordWebhookUrl = discordWebhookEnv ? process.env[discordWebhookEnv] : undefined;
    if (discordWebhookUrl) {
      reporters.push(discordReporter(discordWebhookUrl, log));
      log(`[discord] reporter active (${discordWebhookEnv})`);
    }

    // Fan out to all active reporters. Methods are all optional so undefined is safe.
    const reporter = reporters.length === 0 ? undefined : {
      onPositionOpened: (e: Parameters<NonNullable<typeof reporters[0]['onPositionOpened']>>[0]) =>
        reporters.forEach((r) => r.onPositionOpened?.(e)),
      onPositionClosed: (e: Parameters<NonNullable<typeof reporters[0]['onPositionClosed']>>[0]) =>
        reporters.forEach((r) => r.onPositionClosed?.(e)),
      onCycleSummary: (s: Parameters<NonNullable<typeof reporters[0]['onCycleSummary']>>[0]) =>
        reporters.forEach((r) => r.onCycleSummary?.(s)),
    };

    const stopController = new AbortController();
    const stop = () => stopController.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    const store = new SqliteStore();
    try {
      const liveBroker = await buildLiveBrokerIfNeeded(config, store);
      if (liveBroker) {
        log(`[run] mode=live wallet=${config.chains.solana.walletFile} cash=$${liveBroker.getCashUsd().toFixed(2)} positions=${liveBroker.getOpenPositions().length}`);
        const incompleteExecutions = store.listIncompleteLiveExecutions();
        const journalReport = renderIncompleteLiveExecutions(incompleteExecutions);
        if (journalReport) {
          for (const line of journalReport.split('\n')) log(line);
          throw new Error('Incomplete live executions must be reconciled before starting the run loop. Use recover-positions and verify the journal entries.');
        }

        // Cross-check on-chain SPL balances against SQLite open_positions so any
        // crash-recovery gaps are surfaced before the run loop starts.
        const rpcUrl = config.chains.solana.rpcUrlEnv
          ? process.env[config.chains.solana.rpcUrlEnv]
          : undefined;
        const walletPublicKey = liveBroker.getWalletPublicKey();
        if (rpcUrl && walletPublicKey) {
          const reconciliation = await reconcileWalletPositions({
            walletPublicKey,
            openPositions: store.loadOpenPositions(),
            rpcUrl,
          });
          const report = renderReconciliationReport(reconciliation);
          if (report) log(report);
          if (reconciliation.stale.length > 0) {
            const quarantined = liveBroker.quarantinePositions(
              reconciliation.stale.map((position) => position.positionId),
            );
            log(
              `[reconcile] QUARANTINED ${quarantined} stale live position(s); ` +
              'automated exits and new entries are blocked until recover-positions resolves them',
            );
          }
        }
      }

      // Resolve the exit-only interval: explicit flag > live-mode default (10s) > disabled.
      const exitIntervalSeconds = options.exitIntervalSeconds !== undefined
        ? Number(options.exitIntervalSeconds)
        : liveBroker ? 10 : undefined;
      if (exitIntervalSeconds !== undefined && (!Number.isFinite(exitIntervalSeconds) || exitIntervalSeconds <= 0)) {
        throw new Error('--exit-interval-seconds must be a positive number');
      }

      const result = await runBotLoop({
        apiKey: options.apiKey,
        durationMs: seconds === undefined ? undefined : seconds * 1000,
        processIntervalMs: processIntervalSeconds * 1000,
        exitIntervalMs: exitIntervalSeconds !== undefined ? exitIntervalSeconds * 1000 : undefined,
        processLimit,
        store,
        solanaConfig: config.chains.solana,
        paper: paperBrokerOptions(config),
        // Use the minimum threshold across all strategies so the run loop's
        // retry pass doesn't filter out candidates that belong to a lower-threshold
        // strategy (e.g. migration at 70 vs fresh launch at 75).
        minimumScoreToEnter: Math.min(...strategies.map((s) => s.config.minScoreToEnter)),
        strategies,
        exits: config.exits,
        resolveExits: buildExitResolver(strategies, config.exits),
        analyticsIntervalPasses,
        retention: {
          scoredCandidateDays: config.retention.scoredCandidateDays,
          pumpPortalEventDays: config.retention.pumpPortalEventDays,
          volumeSnapshotDays: config.retention.volumeSnapshotDays,
        },
        stopSignal: stopController.signal,
        onLog: log,
        reporter,
        broker: liveBroker,
        // In live mode, create a real-time watcher so exit evaluations fire the
        // moment a held token has on-chain activity, not just on the next interval.
        createTokenWatcher: liveBroker
          ? (onActivity) => {
              const rpcUrl = config.chains.solana.rpcUrlEnv
                ? process.env[config.chains.solana.rpcUrlEnv]
                : undefined;
              const watcher = new TokenActivityWatcher({
                rpcWsUrl: rpcUrlToWs(rpcUrl!),
                onActivity,
                onLog: log,
                onError: (err) => log(`[watcher:error] ${err.message}`),
              });
              watcher.connect();
              return watcher;
            }
          : undefined,
      });
      process.stdout.write(
        `Run complete. eventsSaved=${result.eventsSaved} processRuns=${result.processRuns} events=${result.eventsRead} enriched=${result.candidatesEnriched} scored=${result.scored} opened=${result.openedPositions} closed=${result.closedPositions} outcomes=${result.outcomesUpdated} skipped=${result.skipped} failed=${result.failed}\n`,
      );
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      store.close();
    }
  });

program
  .command('snapshot')
  .description('Read-only operator snapshot: readiness, wallet balances, open positions, recent trades, journal, and analytics')
  .option('--trades <n>', 'number of recent closed trades to show', '5')
  .action(async (options: { trades: string }) => {
    const tradeLimit = Math.max(1, Number(options.trades) || 5);
    const config = loadConfigFromFile(program.opts().config);
    const store = new SqliteStore();
    const generatedAt = new Date().toISOString();

    try {
      // ── live readiness (static; no wallet read) ──────────────────────────
      const walletFile = config.chains.solana.walletFile;
      const walletFileExists = walletFile ? fs.existsSync(path.resolve(process.cwd(), walletFile)) : false;
      const readiness = evaluateLiveReadiness({
        config,
        env: process.env,
        walletFileExists,
        closedTrades: store.loadClosedTradeStats().length,
        trackedOutcomes: store.loadScoredOutcomeStats().length,
        liveBrokerAvailable: true,
        liveExecutionImplemented: true,
      });

      // ── wallet balances (live only; skipped if RPC not configured) ────────
      let walletBalances;
      let walletError: string | undefined;
      const rpcUrl = config.chains.solana.rpcUrlEnv ? process.env[config.chains.solana.rpcUrlEnv] : undefined;
      if (walletFile && rpcUrl) {
        try {
          const keypair = loadSolanaKeypair(walletFile);
          const deps = createLiveBrokerDeps(keypair, {
            rpcUrl,
            maxSlippageBps: config.chains.solana.maxSlippageBps,
            confirmationCommitment: config.chains.solana.confirmationCommitment,
            priorityFeeLamports: config.chains.solana.priorityFeeLamports ?? 'auto',
          });
          const inventory = await queryWalletCashInventory(
            keypair.publicKey.toBase58(),
            deps,
            solanaRpcRequest(rpcUrl),
          );
          const minReserve = BigInt(
            config.chains.solana.minSolFeeReserveLamports ?? DEFAULT_MIN_SOL_FEE_RESERVE_LAMPORTS,
          );
          walletBalances = {
            publicKey: inventory.publicKey,
            sol: inventory.sol,
            solUsd: inventory.solUsd,
            solPriceUsd: inventory.solPriceUsd,
            usdc: inventory.usdc,
            usdt: inventory.usdt,
            totalUsd: inventory.totalUsd,
            solLamports: inventory.solLamports,
            reserveStatus: (inventory.solLamports >= minReserve ? 'OK' : 'LOW') as 'OK' | 'LOW',
            minReserveLamports: minReserve,
          };
        } catch (err) {
          walletError = `Wallet balance fetch failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // ── journal ───────────────────────────────────────────────────────────
      const incomplete = store.listIncompleteLiveExecutions();
      const journalText = renderIncompleteLiveExecutions(incomplete);
      const journalSummary = journalText ? journalText.trim() : 'No incomplete live executions.';

      // ── positions and trades ──────────────────────────────────────────────
      const openPositions = store.listOpenPositions();
      const recentTrades = store.listClosedTrades(tradeLimit);

      // ── analytics ────────────────────────────────────────────────────────
      const analytics = computeTradeAnalytics(store.loadClosedTradeStats());

      process.stdout.write(
        renderSnapshot({
          mode: config.mode,
          generatedAt,
          readiness,
          walletBalances,
          walletError,
          openPositions,
          recentTrades,
          journalBlockers: incomplete.length,
          journalSummary,
          analytics,
        }),
      );
    } finally {
      store.close();
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
