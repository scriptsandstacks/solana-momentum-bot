import { PaperBroker, type PaperBrokerOptions } from './paperBroker.js';
import type { PaperPosition } from '../types/domain.js';

// The slice of store behavior needed to rehydrate a PaperBroker. Kept narrow so
// both processing and exit passes can depend on it without the full SqliteStore.
export interface BrokerStateStore {
  loadOpenPositions(): PaperPosition[];
  getRealizedPnlUsd(): number;
  getRealizedPnlUsdSince(sinceIso: string): number;
  getNextPositionSeq(): number;
}

export function isBrokerStateStore(store: unknown): store is BrokerStateStore {
  return (
    typeof store === 'object' &&
    store !== null &&
    typeof (store as BrokerStateStore).loadOpenPositions === 'function' &&
    typeof (store as BrokerStateStore).getRealizedPnlUsd === 'function' &&
    typeof (store as BrokerStateStore).getRealizedPnlUsdSince === 'function' &&
    typeof (store as BrokerStateStore).getNextPositionSeq === 'function'
  );
}

export function startOfUtcDayIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

// Build a broker that reflects everything already persisted: open positions,
// cash (derived from realized PnL + open count), and today's realized PnL for
// the daily-loss breaker. This is what keeps maxOpenPositions, cash, and the
// breaker correct across separate processing passes and restarts.
export function restoreBrokerFromStore(
  store: BrokerStateStore,
  options: PaperBrokerOptions,
  now = new Date(),
): PaperBroker {
  return PaperBroker.restore(options, {
    openPositions: store.loadOpenPositions(),
    realizedPnlUsd: store.getRealizedPnlUsd(),
    dailyRealizedPnlUsd: store.getRealizedPnlUsdSince(startOfUtcDayIso(now)),
    nextPositionSeq: store.getNextPositionSeq(),
  });
}
