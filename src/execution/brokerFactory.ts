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
    return new LiveBroker({ solana: options.config.chains.solana });
  }

  return options.store
    ? restoreBrokerFromStore(options.store, options.paper, options.now)
    : new PaperBroker(options.paper);
}
