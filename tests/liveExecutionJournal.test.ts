import { describe, expect, it } from 'vitest';
import {
  inspectSubmittedLiveExecution,
  renderIncompleteLiveExecutions,
  type LiveExecutionJournalEntry,
} from '../src/execution/liveExecutionJournal.js';

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
      lastValidBlockHeight: 100,
      status: 'confirmed',
      createdAt: '2026-06-03T00:00:00.000Z',
      updatedAt: '2026-06-03T00:00:01.000Z',
    }];

    const output = renderIncompleteLiveExecutions(entries);

    expect(output).toContain('incomplete live execution');
    expect(output).toContain('CONFIRMED');
    expect(output).toContain('position=live-1');
    expect(output).toContain('signature=sig-abc');
    expect(output).toContain('lastValidBlockHeight=100');
  });
});

function submittedEntry(overrides: Partial<LiveExecutionJournalEntry> = {}): LiveExecutionJournalEntry {
  return {
    id: 'open:live-1:abc',
    side: 'open',
    positionId: 'live-1',
    mint: 'mint-abc',
    symbol: 'ABC',
    inputMint: 'usdc',
    outputMint: 'mint-abc',
    inputAmountBaseUnits: '25000000',
    signature: 'sig-abc',
    lastValidBlockHeight: 100,
    status: 'submitted',
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:00:01.000Z',
    ...overrides,
  };
}

function makeFetchFn(status: unknown, blockHeight = 100) {
  return async (_url: string | URL | Request, options?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(options?.body)) as { method: string };
    if (body.method === 'getSignatureStatuses') return Response.json({ result: { value: [status] } });
    if (body.method === 'getBlockHeight') return Response.json({ result: blockHeight });
    throw new Error(`Unexpected method ${body.method}`);
  };
}

describe('inspectSubmittedLiveExecution', () => {
  it('resolves an on-chain failed transaction', async () => {
    const result = await inspectSubmittedLiveExecution({
      entry: submittedEntry(),
      rpcUrl: 'https://rpc.example',
      fetchFn: makeFetchFn({ err: { InstructionError: [0, 'Custom'] } }),
    });

    expect(result.resolvable).toBe(true);
    expect(result.reason).toContain('verified on-chain failure');
  });

  it('resolves an expired transaction with no signature status', async () => {
    const result = await inspectSubmittedLiveExecution({
      entry: submittedEntry(),
      rpcUrl: 'https://rpc.example',
      fetchFn: makeFetchFn(null, 101),
    });

    expect(result.resolvable).toBe(true);
    expect(result.reason).toContain('verified expired');
  });

  it('does not resolve a confirmed transaction', async () => {
    const result = await inspectSubmittedLiveExecution({
      entry: submittedEntry(),
      rpcUrl: 'https://rpc.example',
      fetchFn: makeFetchFn({ confirmationStatus: 'confirmed', err: null }),
    });

    expect(result.resolvable).toBe(false);
    expect(result.reason).toContain('recover the resulting wallet state');
  });

  it('does not resolve an outcome that is still unknown', async () => {
    const result = await inspectSubmittedLiveExecution({
      entry: submittedEntry(),
      rpcUrl: 'https://rpc.example',
      fetchFn: makeFetchFn(null, 100),
    });

    expect(result.resolvable).toBe(false);
    expect(result.reason).toContain('still unknown');
  });
});
