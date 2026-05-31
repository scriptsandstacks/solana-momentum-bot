import { fetchPumpPortalMarketCandidates } from './pumpCandidates.js';
import { restoreBrokerFromStore, type BrokerStateStore } from '../paper/restoreBroker.js';
import type { PaperBrokerOptions } from '../paper/paperBroker.js';
import type { PaperPosition, PaperTrade } from '../types/domain.js';

export interface ExitRules {
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number;
  maxHoldMinutes: number;
}

type ExitReason = PaperTrade['reason'];

interface ExitProcessStore extends BrokerStateStore {
  saveClosedTrade(trade: PaperTrade): void;
  saveOpenPosition(position: PaperPosition): void;
}

interface ProcessExitsOptions {
  store: ExitProcessStore;
  paper: PaperBrokerOptions;
  exits: ExitRules;
  // Returns a current USD price per token mint. Defaults to a DexScreener +
  // Raydium lookup. Only positive prices should be returned.
  fetchPrices?: (tokenMints: string[]) => Promise<Map<string, number>>;
  now?: Date;
}

export interface ProcessExitsResult {
  positionsChecked: number;
  repriced: number;
  missingPrice: number;
  closed: number;
  stopLoss: number;
  takeProfit: number;
  trailingStop: number;
  timeout: number;
}

// Decide whether a position should exit given a fresh price. Pure and exported
// so the priority order and trailing-stop math are unit-testable in isolation.
//
// Priority: take-profit (best outcome) > stop-loss (hard floor) > trailing-stop
// > max-hold timeout. The trailing stop only arms once price has risen above
// entry; before that the hard stop-loss is the only downside gate.
export function decideExit(
  position: Pick<PaperPosition, 'entryPriceUsd' | 'highWaterMarkUsd' | 'openedAt'>,
  priceUsd: number,
  highWaterMarkUsd: number,
  exits: ExitRules,
  now: Date,
): ExitReason | undefined {
  const pnlPct = ((priceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;

  if (pnlPct >= exits.takeProfitPct) return 'take_profit';
  if (pnlPct <= -exits.stopLossPct) return 'stop_loss';

  if (highWaterMarkUsd > position.entryPriceUsd) {
    const trailingFloor = highWaterMarkUsd * (1 - exits.trailingStopPct / 100);
    if (priceUsd <= trailingFloor) return 'trailing_stop';
  }

  const heldMinutes = (now.getTime() - position.openedAt.getTime()) / 60_000;
  if (heldMinutes >= exits.maxHoldMinutes) return 'timeout';

  return undefined;
}

async function defaultFetchPrices(tokenMints: string[]): Promise<Map<string, number>> {
  const candidates = await fetchPumpPortalMarketCandidates(tokenMints);
  const prices = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.priceUsd > 0) {
      prices.set(candidate.address, candidate.priceUsd);
    }
  }
  return prices;
}

// Re-price open paper positions and close any that hit a configured exit rule.
// Positions with no fresh price are left untouched (they remain open and are
// retried on the next pass) rather than being closed at a stale price.
export async function processExits(options: ProcessExitsOptions): Promise<ProcessExitsResult> {
  const now = options.now ?? new Date();
  const broker = restoreBrokerFromStore(options.store, options.paper, now);
  const open = broker.getOpenPositions();

  const result: ProcessExitsResult = {
    positionsChecked: open.length,
    repriced: 0,
    missingPrice: 0,
    closed: 0,
    stopLoss: 0,
    takeProfit: 0,
    trailingStop: 0,
    timeout: 0,
  };

  if (open.length === 0) return result;

  const mints = [...new Set(open.map((position) => position.token.address).filter(Boolean))];
  const fetchPrices = options.fetchPrices ?? defaultFetchPrices;
  const prices = await fetchPrices(mints);

  for (const position of open) {
    const price = prices.get(position.token.address);
    if (price === undefined || price <= 0) {
      result.missingPrice += 1;
      continue;
    }
    result.repriced += 1;

    // Ratchet the high-water mark first so trailing-stop math uses the latest peak.
    const updated = broker.updateHighWaterMark(position.id, price);
    const reason = decideExit(position, price, updated.highWaterMarkUsd, options.exits, now);

    if (!reason) {
      // No exit: persist the (possibly raised) high-water mark for next pass.
      options.store.saveOpenPosition(updated);
      continue;
    }

    const trade = broker.closePosition(position.id, price, reason, now);
    options.store.saveClosedTrade(trade);
    result.closed += 1;
    if (reason === 'stop_loss') result.stopLoss += 1;
    else if (reason === 'take_profit') result.takeProfit += 1;
    else if (reason === 'trailing_stop') result.trailingStop += 1;
    else if (reason === 'timeout') result.timeout += 1;
  }

  return result;
}
