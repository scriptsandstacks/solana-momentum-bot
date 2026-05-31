import { PaperBroker } from '../paper/paperBroker.js';
import { scoreTokenCandidate } from '../scoring/scoreToken.js';
import type { OpportunityScore, PaperPosition, TokenCandidate } from '../types/domain.js';

interface PaperCycleStore {
  saveScoredCandidate(candidate: TokenCandidate, score: OpportunityScore): void;
  saveOpenPosition(position: PaperPosition): void;
}

interface PaperCycleInput {
  candidates: TokenCandidate[];
  paper: {
    startingBalanceUsd: number;
    positionSizeUsd: number;
    maxOpenPositions: number;
  };
  minimumScoreToEnter: number;
  store?: PaperCycleStore;
}

export function runPaperCycle(input: PaperCycleInput) {
  const broker = new PaperBroker(input.paper);
  const scored = input.candidates.map((candidate) => ({ candidate, score: scoreTokenCandidate(candidate) }));

  for (const { candidate, score } of scored) {
    input.store?.saveScoredCandidate(candidate, score);
    if (score.total >= input.minimumScoreToEnter && score.recommendation === 'paper_trade') {
      try {
        const position = broker.openPosition(candidate, score.total);
        input.store?.saveOpenPosition(position);
      } catch {
        break;
      }
    }
  }

  return { broker, scored };
}
