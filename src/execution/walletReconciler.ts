// At startup in live mode, cross-references the wallet's on-chain SPL token
// balances against the open_positions table in SQLite.
//
// Two classes of discrepancy are detected:
//   ORPHANED — tokens held on-chain with no matching SQLite position. This
//     happens when the process crashes after a confirmed swap but before
//     store.saveOpenPosition() is called. The bot will not track or exit
//     these tokens without manual intervention.
//   STALE    — positions recorded in SQLite with no meaningful on-chain
//     balance. Can happen if a position was closed outside the bot (manual
//     sell, partial fill, etc.). These positions will fail to close via the
//     exit pass until they are removed from open_positions.
//
// Reconciliation is best-effort and non-blocking: a failed RPC call is
// reported but does not prevent the bot from starting.

import type { PaperPosition } from '../types/domain.js';

// Standard SPL Token program. Pump.fun tokens use this exclusively.
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// Mints excluded from the "orphaned" report — these are stablecoins and
// wrapped SOL that represent capital, not trading positions.
const EXCLUDED_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY2Sr6MGt9RktwD',  // USDT
  'So11111111111111111111111111111111111111112',     // wSOL
]);

// Minimum token balance (in UI units) to count as a real holding; anything
// below this is considered dust and excluded from reconciliation.
const MIN_UI_AMOUNT = 0.001;

// A position is considered "matched" when the on-chain balance is at least
// this fraction of the expected quantity recorded in SQLite.
const MIN_MATCH_RATIO = 0.01;

export interface OrphanedHolding {
  mint: string;
  uiAmount: number;
}

export interface StalePosition {
  positionId: string;
  mint: string;
  symbol: string;
  expectedQuantity: number;
  // Actual on-chain balance in UI (decimal) units; 0 when not found.
  actualUiAmount: number;
}

export interface ReconciliationResult {
  orphaned: OrphanedHolding[];
  stale: StalePosition[];
  matched: number;
  // Set when the RPC call failed; reconciliation is incomplete.
  error?: string;
}

export interface ReconcileOptions {
  walletPublicKey: string;
  openPositions: PaperPosition[];
  rpcUrl: string;
  fetchFn?: typeof fetch;
}

type TokenAccountRow = {
  mint: string;
  uiAmount: number;
};

async function fetchWalletTokenAccounts(
  walletPublicKey: string,
  rpcUrl: string,
  fetchFn: typeof fetch,
): Promise<TokenAccountRow[] | { error: string }> {
  try {
    const res = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTokenAccountsByOwner',
        params: [
          walletPublicKey,
          { programId: TOKEN_PROGRAM_ID },
          { encoding: 'jsonParsed' },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return { error: `HTTP ${res.status}` };

    const json = (await res.json()) as {
      result?: {
        value?: Array<{
          account?: {
            data?: {
              parsed?: {
                info?: {
                  mint?: string;
                  tokenAmount?: { uiAmount?: number | null };
                };
              };
            };
          };
        }>;
      };
      error?: { message: string };
    };

    if (json.error) return { error: json.error.message };

    const accounts: TokenAccountRow[] = [];
    for (const item of json.result?.value ?? []) {
      const info = item.account?.data?.parsed?.info;
      if (!info?.mint) continue;
      const uiAmount = info.tokenAmount?.uiAmount ?? 0;
      accounts.push({ mint: info.mint, uiAmount });
    }
    return accounts;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function reconcileWalletPositions(options: ReconcileOptions): Promise<ReconciliationResult> {
  const fetchFn = options.fetchFn ?? fetch;

  const accountsOrError = await fetchWalletTokenAccounts(
    options.walletPublicKey,
    options.rpcUrl,
    fetchFn,
  );

  if ('error' in accountsOrError) {
    return { orphaned: [], stale: [], matched: 0, error: accountsOrError.error };
  }

  // Build a mint → uiAmount map for all non-dust holdings the wallet actually has.
  const walletBalances = new Map<string, number>();
  for (const { mint, uiAmount } of accountsOrError) {
    if (uiAmount >= MIN_UI_AMOUNT) {
      walletBalances.set(mint, uiAmount);
    }
  }

  // Build a set of mints covered by open positions in SQLite.
  const trackedMints = new Set(options.openPositions.map((p) => p.token.address));

  // --- ORPHANED: on-chain holdings with no SQLite position ---
  const orphaned: OrphanedHolding[] = [];
  for (const [mint, uiAmount] of walletBalances) {
    if (!trackedMints.has(mint) && !EXCLUDED_MINTS.has(mint)) {
      orphaned.push({ mint, uiAmount });
    }
  }

  // --- STALE / MATCHED: SQLite positions vs on-chain balance ---
  const stale: StalePosition[] = [];
  let matched = 0;

  for (const position of options.openPositions) {
    const onChainAmount = walletBalances.get(position.token.address) ?? 0;
    const matchRatio = position.quantity > 0 ? onChainAmount / position.quantity : 0;

    if (matchRatio >= MIN_MATCH_RATIO) {
      matched += 1;
    } else {
      stale.push({
        positionId: position.id,
        mint: position.token.address,
        symbol: position.token.symbol,
        expectedQuantity: position.quantity,
        actualUiAmount: onChainAmount,
      });
    }
  }

  return { orphaned, stale, matched };
}

export function renderReconciliationReport(result: ReconciliationResult): string {
  const lines: string[] = [];

  if (result.error) {
    lines.push(`[reconcile] WARNING: could not query on-chain balances (${result.error}); skipping reconciliation`);
    return lines.join('\n');
  }

  const issues = result.orphaned.length + result.stale.length;
  if (issues === 0) {
    if (result.matched > 0) {
      lines.push(`[reconcile] OK: ${result.matched} position(s) verified on-chain`);
    }
    return lines.join('\n');
  }

  lines.push(`[reconcile] WARNING: ${issues} discrepancy(s) detected between wallet and SQLite`);

  for (const h of result.orphaned) {
    lines.push(
      `[reconcile] ORPHANED  mint=${h.mint} amount=${h.uiAmount.toFixed(4)} ` +
      `— tokens held on-chain with no open_positions record. ` +
      `If from a previous crash, close or re-enter the position manually.`,
    );
  }

  for (const s of result.stale) {
    lines.push(
      `[reconcile] STALE     positionId=${s.positionId} mint=${s.mint} symbol=${s.symbol} ` +
      `expected=${s.expectedQuantity.toFixed(4)} on-chain=${s.actualUiAmount.toFixed(4)} ` +
      `— position in SQLite but no matching on-chain balance. ` +
      `Live run will quarantine it until recover-positions resolves it.`,
    );
  }

  if (result.matched > 0) {
    lines.push(`[reconcile] ${result.matched} position(s) matched`);
  }

  return lines.join('\n');
}
