import { PaperBroker, type PaperBrokerOptions } from '../paper/paperBroker.js';
import { restoreBrokerFromStore, isBrokerStateStore, type BrokerStateStore } from '../paper/restoreBroker.js';
import { scoreTokenCandidate } from '../scoring/scoreToken.js';
import type { OpportunityScore, PaperPosition, TokenCandidate } from '../types/domain.js';

interface PaperCycleStore {
  saveScoredCandidate(candidate: TokenCandidate, score: OpportunityScore): void;
  saveOpenPosition(position: PaperPosition): void;
}

interface PaperCycleInput {
  candidates: TokenCandidate[];
  paper: PaperBrokerOptions;
  minimumScoreToEnter: number;
  // The real SqliteStore also exposes broker-state reads, which enable
  // rehydration; minimal stores (tests) may omit them.
  store?: PaperCycleStore & Partial<BrokerStateStore>;
}

export function runPaperCycle(input: PaperCycleInput) {
  // Rehydrate from persisted state so cash, the position cap, and the daily-loss
  // breaker stay correct across runs (matching pump-process/exits). A minimal
  // store without broker-state reads (e.g. unit tests) gets a fresh broker.
  const broker = isBrokerStateStore(input.store)
    ? restoreBrokerFromStore(input.store, input.paper)
    : new PaperBroker(input.paper);
  const scored = input.candidates.map((candidate) => ({ candidate, score: scoreTokenCandidate(candidate) }));

  for (const { candidate, score } of scored) {
    // Persist every scored candidate. A blocked/failed open must not skip the
    // remaining candidates' scored rows, so never break out of the loop.
    input.store?.saveScoredCandidate(candidate, score);
    if (score.total < input.minimumScoreToEnter || score.recommendation !== 'paper_trade') continue;
    if (!broker.canOpenPosition().ok) continue;
    try {
      const position = broker.openPosition(candidate, score.total);
      input.store?.saveOpenPosition(position);
    } catch {
      // Defensive (e.g. non-positive price): skip this candidate, keep scoring.
      continue;
    }
  }

  return { broker, scored };
}
