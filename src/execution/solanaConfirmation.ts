export interface ConfirmSolanaTransactionOptions {
  signature: string;
  lastValidBlockHeight?: number;
  rpcRequest: (method: string, params: unknown[]) => Promise<unknown>;
  commitment?: 'confirmed' | 'finalized';
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function confirmSolanaTransaction(options: ConfirmSolanaTransactionOptions): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 90_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const commitment = options.commitment ?? 'confirmed';
  const deadline = now() + timeoutMs;

  while (now() < deadline) {
    const result = await options.rpcRequest('getSignatureStatuses', [
      [options.signature],
      { searchTransactionHistory: true },
    ]);
    const statuses = (result as { value: Array<{ confirmationStatus?: string; err?: unknown } | null> }).value;
    const status = statuses?.[0];
    if (status?.err) {
      throw new Error(`Transaction ${options.signature} failed on-chain: ${JSON.stringify(status.err)}`);
    }
    if (isAcceptedCommitment(status?.confirmationStatus, commitment)) {
      return;
    }

    if (options.lastValidBlockHeight !== undefined) {
      const blockHeight = await options.rpcRequest('getBlockHeight', [{ commitment }]);
      if (typeof blockHeight === 'number' && blockHeight > options.lastValidBlockHeight) {
        throw new Error(
          `Transaction ${options.signature} expired at block height ${options.lastValidBlockHeight} ` +
          `(current ${blockHeight}) before confirmation`,
        );
      }
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Transaction ${options.signature} was not confirmed within ${Math.round(timeoutMs / 1000)} seconds`);
}

function isAcceptedCommitment(
  actual: string | undefined,
  required: 'confirmed' | 'finalized',
): boolean {
  if (required === 'finalized') return actual === 'finalized';
  return actual === 'confirmed' || actual === 'finalized';
}
