import { Command } from 'commander';
import { renderReport } from '../bot/report.js';
import { runPaperCycle } from '../bot/paperCycle.js';
import { renderStorageReport } from '../bot/storageReport.js';
import { runPumpWatch } from '../bot/pumpWatch.js';
import { processPumpPortalEvents } from '../bot/pumpProcess.js';
import { processExits } from '../bot/exitPositions.js';
import { runBotLoop } from '../bot/runLoop.js';
import { loadConfigFromFile } from '../config/loadConfig.js';
import { scanSolanaCandidates } from '../chains/solana/scanner.js';
import { checkJupiterRoute } from '../discovery/jupiter.js';
import { PaperBroker } from '../paper/paperBroker.js';
import { scoreTokenCandidate } from '../scoring/scoreToken.js';
import { SqliteStore } from '../storage/sqliteStore.js';
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

const program = new Command();

program
  .name('hermes-paper-bot')
  .description('Solana-first, multi-chain-ready paper trading bot')
  .option('-c, --config <path>', 'config file path', 'config.yaml');

program.command('scan').description('Scan enabled chains and print scored candidates').action(async () => {
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
      process.stdout.write('No route available (token may be unswappable, illiquid, or the quote API is unreachable).\n');
    }
  });

program.command('paper').description('Run one paper-trading scan cycle').action(async () => {
  const config = loadConfigFromFile(program.opts().config);
  const store = new SqliteStore();
  const candidates = config.chains.solana.enabled ? await scanSolanaCandidates(config.chains.solana) : [];
  const { broker, scored } = runPaperCycle({
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
    const store = new SqliteStore();
    const result = await processExits({
      store,
      paper: paperBrokerOptions(config),
      exits: config.exits,
    });
    store.close();
    process.stdout.write(
      `Exit pass complete. checked=${result.positionsChecked} repriced=${result.repriced} closed=${result.closed} stopLoss=${result.stopLoss} takeProfit=${result.takeProfit} trailingStop=${result.trailingStop} timeout=${result.timeout} noPrice=${result.missingPrice}\n`,
    );
  });

program
  .command('run')
  .description('Continuously watch PumpPortal and process pending events into paper candidates')
  .option('--api-key <key>', 'PumpPortal API key; defaults to PUMPPORTAL_API_KEY')
  .option('--process-interval-seconds <seconds>', 'seconds between PumpPortal processing passes', '30')
  .option('--process-limit <limit>', 'maximum pending PumpPortal events per processing pass', '50')
  .option('--seconds <seconds>', 'optional bounded runtime in seconds; omit to run until Ctrl-C')
  .action(async (options: { apiKey?: string; processIntervalSeconds: string; processLimit: string; seconds?: string }) => {
    const processIntervalSeconds = Number(options.processIntervalSeconds);
    const processLimit = Number(options.processLimit);
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

    const stopController = new AbortController();
    const stop = () => stopController.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    const store = new SqliteStore();
    try {
      const result = await runBotLoop({
        apiKey: options.apiKey,
        durationMs: seconds === undefined ? undefined : seconds * 1000,
        processIntervalMs: processIntervalSeconds * 1000,
        processLimit,
        store,
        solanaConfig: config.chains.solana,
        paper: paperBrokerOptions(config),
        minimumScoreToEnter: config.scoring.minimumScoreToEnter,
        exits: config.exits,
        stopSignal: stopController.signal,
        onLog: (message) => process.stdout.write(`${message}\n`),
      });
      process.stdout.write(
        `Run complete. eventsSaved=${result.eventsSaved} processRuns=${result.processRuns} events=${result.eventsRead} enriched=${result.candidatesEnriched} scored=${result.scored} opened=${result.openedPositions} closed=${result.closedPositions} skipped=${result.skipped} failed=${result.failed}\n`,
      );
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      store.close();
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
