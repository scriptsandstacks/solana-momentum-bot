export type LiveExecutionSide = 'open' | 'close';
export type LiveExecutionStatus = 'prepared' | 'submitted' | 'confirmed' | 'persisted' | 'failed';

export interface LiveExecutionJournalEntry {
  id: string;
  side: LiveExecutionSide;
  positionId: string;
  mint: string;
  symbol: string;
  inputMint: string;
  outputMint: string;
  inputAmountBaseUnits: string;
  signature?: string;
  status: LiveExecutionStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LiveExecutionJournalStore {
  recordLiveExecutionPrepared(entry: Omit<LiveExecutionJournalEntry, 'signature' | 'status' | 'error' | 'createdAt' | 'updatedAt'>): void;
  recordLiveExecutionSubmitted(id: string, signature: string): void;
  recordLiveExecutionConfirmed(id: string): void;
  recordLiveExecutionFailed(id: string, error: string): void;
}

export function renderIncompleteLiveExecutions(entries: LiveExecutionJournalEntry[]): string {
  if (entries.length === 0) return '';
  const lines = [`[journal] WARNING: ${entries.length} incomplete live execution(s) require review`];
  for (const entry of entries) {
    lines.push(
      `[journal] ${entry.status.toUpperCase()} side=${entry.side} position=${entry.positionId} ` +
      `symbol=${entry.symbol} mint=${entry.mint} signature=${entry.signature ?? 'none'} updated=${entry.updatedAt}`,
    );
  }
  return lines.join('\n');
}
