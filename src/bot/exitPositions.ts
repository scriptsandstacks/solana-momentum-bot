import { fetchPumpPortalMarketCandidates } from './pumpCandidates.js';
import { quoteJupiterSellImpactBps } from '../discovery/jupiter.js';
import { restoreBrokerFromStore, type BrokerStateStore } from '../paper/restoreBroker.js';
import type { PaperBrokerOptions } from '../paper/paperBroker.js';
import type { ExecutionBroker } from '../execution/broker.js';
import type { Reporter } from './reporter.js';
import type { PaperPosition, PaperTrade } from '../types/domain.js';

export interface ExitRules {
  stopLossPct: number;
  // A fixed take-profit ceiling. On fat-tailed assets (memecoins, fresh launches)
  // this should be set very high (200–500) so the trailing stop — not a fixed
  // ceiling — is the actual exit. A low takeProfitPct (e.g. 50) systematically
  // cuts winners short on assets that can move 5-20x.
  takeProfitPct: number;
  // How far price must pull back from the high-water mark to exit.
  trailingStopPct: number;
  // Minimum unrealized gain (%) required before the trailing stop arms.
  // Phase 1 (below this threshold): only the hard stop-loss applies.
  // Phase 2 (at or above): trailing stop takes over as the downside gate.
  // Set to 0 to use the old behavior (trailing arms on any gain above entry).
  trailingArmPct: number;
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
  // Optional per-strategy exit override resolver. When provided, called with the
  // position's strategyId to return the exits to use for that position, allowing
  // different strategies to have different stop-loss / take-profit thresholds.
  // Falls back to options.exits when absent or when the resolver returns undefined.
  resolveExits?: (strategyId: string | undefined) => ExitRules | undefined;
  // Returns a current USD price per token mint. Defaults to a DexScreener +
  // Raydium lookup. Only positive prices should be returned.
  fetchPrices?: (tokenMints: string[]) => Promise<Map<string, number>>;
  // Returns the fresh sell-side price impact (bps) for exiting a position of the
  // given USD value, or undefined when no quote is available. Defaults to a
  // Jupiter ExactOut sell quote. Only consulted when the cost model applies
  // route slippage, so frictionless runs make no extra network calls.
  fetchExitSlippageBps?: (tokenMint: string, positionValueUsd: number) => Promise<number | undefined>;
  now?: Date;
  reporter?: Reporter;
  // When provided, use this broker directly instead of reconstructing from store.
  broker?: ExecutionBroker;
  onLog?: (message: string) => void;
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
  // Count of positions where the close attempt threw (live tx failures etc.).
  // These positions remain open and will be retried on the next exit pass.
  failed: number;
}

function minutesHeld(openedAt: Date, now: Date): number {
  return (now.getTime() - openedAt.getTime()) / 60_000;
}

// Decide whether a position should exit given a fresh price. Pure and exported
// so the priority order and trailing-stop math are unit-testable in isolation.
//
// Two-phase exit model:
//   Phase 1 — below trailingArmPct gain: only the hard stop-loss applies.
//             No trailing stop, no take-profit ceiling (unless explicitly set low).
//             This gives a fresh position room to breathe before locking in gains.
//   Phase 2 — at or above trailingArmPct gain: trailing stop takes over as the
//             primary downside gate. The fixed take-profit (if set below 200%) acts
//             as a safety ceiling but should normally not fire if trailingArmPct
//             and trailingStopPct are calibrated for the asset's volatility.
//
// Priority within each phase: take-profit > stop-loss > trailing-stop > timeout.
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

  // Trailing stop only arms once the position has gained at least trailingArmPct.
  // The high-water mark must also have reached that level — a brief spike followed
  // by immediate reversal should not arm the stop against the current price.
  const trailingArmPrice = position.entryPriceUsd * (1 + exits.trailingArmPct / 100);
  if (highWaterMarkUsd >= trailingArmPrice) {
    const trailingFloor = highWaterMarkUsd * (1 - exits.trailingStopPct / 100);
    if (priceUsd <= trailingFloor) return 'trailing_stop';
  }

  if (minutesHeld(position.openedAt, now) >= exits.maxHoldMinutes) return 'timeout';

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

function defaultFetchExitSlippageBps(tokenMint: string, positionValueUsd: number): Promise<number | undefined> {
  return quoteJupiterSellImpactBps(tokenMint, positionValueUsd);
}

// Re-price open paper positions and close any that hit a configured exit rule.
// When no fresh price is available, stop-loss / take-profit / trailing exits are
// skipped (they must react to a real current price), but a max-hold timeout still
// fires — closing at the last known mark — so an unpriceable position cannot hold
// its slot forever. Positions that are neither priceable nor timed out are left
// open and retried next pass.
export async function processExits(options: ProcessExitsOptions): Promise<ProcessExitsResult> {
  const now = options.now ?? new Date();
  const broker = options.broker ?? restoreBrokerFromStore(options.store, options.paper, now);
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
    failed: 0,
  };

  if (open.length === 0) return result;

  const mints = [...new Set(open.map((position) => position.token.address).filter(Boolean))];
  const fetchPrices = options.fetchPrices ?? defaultFetchPrices;
  const fetchExitSlippageBps = options.fetchExitSlippageBps ?? defaultFetchExitSlippageBps;
  // Only spend a sell-quote when the cost model would actually use route
  // slippage; otherwise the exit fill is frictionless and the call is wasted.
  const usesRouteSlippage = options.paper.costModel?.applyRouteSlippage === true;
  const prices = await fetchPrices(mints);

  const recordClose = async (
    positionId: string,
    exitPriceUsd: number,
    reason: ExitReason,
    exitPriceSource: NonNullable<PaperTrade['exitPriceSource']> = 'fresh',
    exitSlippageBps?: number,
  ) => {
    const trade = await broker.closePosition(positionId, exitPriceUsd, reason, now, exitPriceSource, exitSlippageBps);
    options.store.saveClosedTrade(trade);
    options.reporter?.onPositionClosed?.({ trade });
    result.closed += 1;
    if (reason === 'stop_loss') result.stopLoss += 1;
    else if (reason === 'take_profit') result.takeProfit += 1;
    else if (reason === 'trailing_stop') result.trailingStop += 1;
    else if (reason === 'timeout') result.timeout += 1;
  };

  for (const position of open) {
    const positionExits = options.resolveExits?.(position.token.strategyId) ?? options.exits;
    const price = prices.get(position.token.address);

    try {
      if (price === undefined || price <= 0) {
        // No fresh price. Time-based exits still apply: close an over-held position
        // at its last known mark (entry price if it was never marked) so it frees
        // its slot. Price-based exits are skipped until a real price returns.
        if (minutesHeld(position.openedAt, now) >= positionExits.maxHoldMinutes) {
          const exitPriceSource = position.lastMarkUsd === undefined ? 'entry_fallback' : 'last_mark';
          await recordClose(position.id, position.lastMarkUsd ?? position.entryPriceUsd, 'timeout', exitPriceSource);
        } else {
          result.missingPrice += 1;
        }
        continue;
      }
      result.repriced += 1;

      // Record the mark (ratchets the high-water mark) before evaluating exits so
      // trailing-stop math uses the latest peak.
      const updated = broker.recordMark(position.id, price);
      const reason = decideExit(position, price, updated.highWaterMarkUsd, positionExits, now);

      if (!reason) {
        // No exit: persist the updated marks for the next pass.
        options.store.saveOpenPosition(updated);
        continue;
      }

      // Freshly quote the sell-side impact for the actual position size so the
      // exit fill reflects what unwinding really costs, not the entry probe.
      // Best-effort: a missing quote falls back to the entry estimate in the broker.
      const exitSlippageBps = usesRouteSlippage
        ? await fetchExitSlippageBps(position.token.address, price * position.quantity)
        : undefined;
      await recordClose(position.id, price, reason, 'fresh', exitSlippageBps);
    } catch (error) {
      // A single position failure (e.g. live swap rejected) must not abort the
      // entire exit pass. Log and continue — the position stays open and will be
      // retried on the next pass.
      result.failed += 1;
      options.onLog?.(
        `[exits:error] position=${position.id} token=${position.token.symbol} ` +
        `error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return result;
}
