import { fetchPumpPortalMarketCandidates } from './pumpCandidates.js';
import type {
  ScoredOutcomeUpdate,
  TrackableScoredCandidateRow,
} from '../storage/sqliteStore.js';

// Forward-outcome tracking for scored candidates we did or did not trade. For a
// bounded window after scoring (the trade horizon), re-price each candidate and
// record its high/low/last so we can later measure maximum favorable/adverse
// excursion (MFE/MAE) vs the scored price. This is the counterfactual dataset
// that tells us whether the score threshold and exit rules leave money on the
// table — e.g. "skipped candidates scoring 70-74 reached +50% X% of the time".

export interface TrackOutcomesStore {
  listTrackableScoredCandidates(limit?: number): TrackableScoredCandidateRow[];
  markStaleScoredOutcomesDone(cutoffIso: string): number;
  recordScoredOutcome(update: ScoredOutcomeUpdate): void;
}

interface TrackOutcomesOptions {
  store: TrackOutcomesStore;
  // How long after scoring to keep tracking a candidate. Matched to the trade
  // horizon (maxHoldMinutes) so outcomes are comparable to what a trade would
  // have experienced.
  horizonMinutes: number;
  limit?: number;
  // Returns a current USD price per mint. Defaults to the same DexScreener +
  // Raydium lookup used by the exit engine.
  fetchPrices?: (tokenMints: string[]) => Promise<Map<string, number>>;
  now?: Date;
}

export interface TrackOutcomesResult {
  finalized: number;
  tracked: number;
  updated: number;
  completed: number;
  missingPrice: number;
}

async function defaultFetchPrices(tokenMints: string[]): Promise<Map<string, number>> {
  const candidates = await fetchPumpPortalMarketCandidates(tokenMints);
  const prices = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.priceUsd > 0) prices.set(candidate.address, candidate.priceUsd);
  }
  return prices;
}

function minutesSince(createdAtIso: string, now: Date): number {
  return (now.getTime() - new Date(createdAtIso).getTime()) / 60_000;
}

export async function trackCandidateOutcomes(options: TrackOutcomesOptions): Promise<TrackOutcomesResult> {
  const now = options.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - options.horizonMinutes * 60_000).toISOString();

  // Finalize anything past the window first so it is neither returned below nor
  // re-checked on future passes.
  const finalized = options.store.markStaleScoredOutcomesDone(cutoffIso);

  const rows = options.store.listTrackableScoredCandidates(options.limit ?? 200);
  const result: TrackOutcomesResult = {
    finalized,
    tracked: rows.length,
    updated: 0,
    completed: 0,
    missingPrice: 0,
  };
  if (rows.length === 0) return result;

  const mints = [...new Set(rows.map((row) => row.address).filter(Boolean))];
  const fetchPrices = options.fetchPrices ?? defaultFetchPrices;
  const prices = await fetchPrices(mints);

  for (const row of rows) {
    const price = prices.get(row.address);
    if (price === undefined || price <= 0) {
      // No fresh price this pass; leave it for a retry (and eventual finalize).
      result.missingPrice += 1;
      continue;
    }

    // Seed the excursion bounds from the scored price so MFE >= 0 and MAE <= 0
    // are measured from the baseline the candidate had when it was scored.
    const prevHigh = row.outcomeHighUsd ?? row.scoredPriceUsd;
    const prevLow = row.outcomeLowUsd ?? row.scoredPriceUsd;
    const done = minutesSince(row.createdAt, now) >= options.horizonMinutes;

    options.store.recordScoredOutcome({
      id: row.id,
      outcomeHighUsd: Math.max(prevHigh, price),
      outcomeLowUsd: Math.min(prevLow, price),
      outcomeLastUsd: price,
      outcomeLastAt: now.toISOString(),
      done,
    });
    result.updated += 1;
    if (done) result.completed += 1;
  }

  return result;
}
