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
  lastValidBlockHeight?: number;
  status: LiveExecutionStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LiveExecutionJournalStore {
  recordLiveExecutionPrepared(entry: Omit<LiveExecutionJournalEntry, 'signature' | 'status' | 'error' | 'createdAt' | 'updatedAt'>): void;
  recordLiveExecutionSubmitted(id: string, signature: string, lastValidBlockHeight?: number): void;
  recordLiveExecutionConfirmed(id: string): void;
  recordLiveExecutionFailed(id: string, error: string): void;
}

export type LiveExecutionResolution =
  | { resolvable: true; reason: string }
  | { resolvable: false; reason: string };

export async function inspectSubmittedLiveExecution(options: {
  entry: LiveExecutionJournalEntry;
  rpcUrl: string;
  fetchFn?: typeof fetch;
}): Promise<LiveExecutionResolution> {
  const { entry } = options;
  if (entry.status !== 'submitted') {
    return { resolvable: false, reason: `only submitted executions can be resolved as failed (status=${entry.status})` };
  }
  if (!entry.signature) {
    return { resolvable: false, reason: 'submitted execution has no transaction signature' };
  }

  const fetchFn = options.fetchFn ?? fetch;
  const statusResult = await rpcRequest<{ value: Array<{ confirmationStatus?: string; err?: unknown } | null> }>(
    options.rpcUrl,
    'getSignatureStatuses',
    [[entry.signature], { searchTransactionHistory: true }],
    fetchFn,
  );
  const status = statusResult.value?.[0];
  if (status?.err) {
    return { resolvable: true, reason: `verified on-chain failure: ${JSON.stringify(status.err)}` };
  }
  if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
    return { resolvable: false, reason: `transaction is ${status.confirmationStatus}; recover the resulting wallet state instead` };
  }

  if (entry.lastValidBlockHeight !== undefined) {
    const blockHeight = await rpcRequest<number>(
      options.rpcUrl,
      'getBlockHeight',
      [{ commitment: 'confirmed' }],
      fetchFn,
    );
    if (blockHeight > entry.lastValidBlockHeight) {
      return {
        resolvable: true,
        reason: `verified expired before confirmation at block height ${entry.lastValidBlockHeight} (current ${blockHeight})`,
      };
    }
  }

  return { resolvable: false, reason: 'transaction outcome is still unknown; keep the journal row incomplete' };
}

export function renderIncompleteLiveExecutions(entries: LiveExecutionJournalEntry[]): string {
  if (entries.length === 0) return '';
  const lines = [`[journal] WARNING: ${entries.length} incomplete live execution(s) require review`];
  for (const entry of entries) {
    lines.push(
      `[journal] ${entry.status.toUpperCase()} side=${entry.side} position=${entry.positionId} ` +
      `symbol=${entry.symbol} mint=${entry.mint} signature=${entry.signature ?? 'none'} ` +
      `lastValidBlockHeight=${entry.lastValidBlockHeight ?? 'unknown'} updated=${entry.updatedAt}`,
    );
  }
  return lines.join('\n');
}

async function rpcRequest<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  fetchFn: typeof fetch,
): Promise<T> {
  const response = await fetchFn(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Solana RPC ${method} failed: ${response.status} ${response.statusText}`);
  const json = await response.json() as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`Solana RPC ${method}: ${json.error.message}`);
  return json.result as T;
}
