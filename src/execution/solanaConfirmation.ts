export interface ConfirmSolanaTransactionOptions {
  signature: string;
  lastValidBlockHeight?: number;
  rpcRequest: (method: string, params: unknown[]) => Promise<unknown>;
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
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return;
    }

    if (options.lastValidBlockHeight !== undefined) {
      const blockHeight = await options.rpcRequest('getBlockHeight', [{ commitment: 'confirmed' }]);
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
