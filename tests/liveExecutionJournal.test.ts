import { describe, expect, it } from 'vitest';
import { renderIncompleteLiveExecutions, type LiveExecutionJournalEntry } from '../src/execution/liveExecutionJournal.js';

describe('renderIncompleteLiveExecutions', () => {
  it('returns empty output when no executions require review', () => {
    expect(renderIncompleteLiveExecutions([])).toBe('');
  });

  it('renders submitted and confirmed execution details', () => {
    const entries: LiveExecutionJournalEntry[] = [{
      id: 'open:live-1:abc',
      side: 'open',
      positionId: 'live-1',
      mint: 'mint-abc',
      symbol: 'ABC',
      inputMint: 'usdc',
      outputMint: 'mint-abc',
      inputAmountBaseUnits: '25000000',
      signature: 'sig-abc',
      status: 'confirmed',
      createdAt: '2026-06-03T00:00:00.000Z',
      updatedAt: '2026-06-03T00:00:01.000Z',
    }];

    const output = renderIncompleteLiveExecutions(entries);

    expect(output).toContain('incomplete live execution');
    expect(output).toContain('CONFIRMED');
    expect(output).toContain('position=live-1');
    expect(output).toContain('signature=sig-abc');
  });
});
