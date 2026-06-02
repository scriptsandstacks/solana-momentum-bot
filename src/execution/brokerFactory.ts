import type { BotConfig } from '../config/schema.js';
import { PaperBroker, type PaperBrokerOptions } from '../paper/paperBroker.js';
import { restoreBrokerFromStore, type BrokerStateStore } from '../paper/restoreBroker.js';
import type { ExecutionBroker } from './broker.js';
import { LiveBroker } from './liveBroker.js';

export interface BrokerFactoryOptions {
  config: BotConfig;
  paper: PaperBrokerOptions;
  store?: BrokerStateStore;
  now?: Date;
}

export function createExecutionBroker(options: BrokerFactoryOptions): ExecutionBroker {
  if (options.config.mode === 'live') {
    // No deps injected — canOpenPosition() works but openPosition/closePosition
    // will throw until the CLI calls LiveBroker.restore() with real deps.
    return new LiveBroker({
      solana: options.config.chains.solana,
      positionSizeUsd: options.paper.positionSizeUsd,
      maxOpenPositions: options.paper.maxOpenPositions,
      maxDailyLossUsd: options.paper.maxDailyLossUsd,
    });
  }

  return options.store
    ? restoreBrokerFromStore(options.store, options.paper, options.now)
    : new PaperBroker(options.paper);
}
