import type { OpportunityScore, TokenCandidate } from '../types/domain.js';

interface ScoredCandidate {
  candidate: TokenCandidate;
  score: OpportunityScore;
}

interface ReportInput {
  candidates: ScoredCandidate[];
  cashUsd: number;
  openPositions: number;
  closedTrades: number;
}

export function renderReport(input: ReportInput): string {
  const lines = [
    'Solana Trade Engine Report',
    `Candidates: ${input.candidates.length}`,
    `Cash: $${input.cashUsd.toFixed(2)}`,
    `Open positions: ${input.openPositions}`,
    `Closed trades: ${input.closedTrades}`,
  ];

  const top = [...input.candidates].sort((a, b) => b.score.total - a.score.total).slice(0, 10);
  for (const { candidate, score } of top) {
    const route = candidate.routeAvailable ? (candidate.routeInputSymbol ?? 'available') : 'none';
    const reasons = score.reasons.length > 0 ? score.reasons.join(',') : 'none';
    const risks = score.risks.length > 0 ? score.risks.join(',') : 'none';
    lines.push(
      `${candidate.chain.toUpperCase()} ${candidate.symbol} score=${score.total} rec=${score.recommendation} price=$${candidate.priceUsd} liq=$${Math.round(candidate.liquidityUsd)} vol5m=$${Math.round(candidate.volume5mUsd)} route=${route} slipBps=${candidate.estimatedSlippageBps} reasons=${reasons} risks=${risks}`,
    );
  }

  return `${lines.join('\n')}\n`;
}
