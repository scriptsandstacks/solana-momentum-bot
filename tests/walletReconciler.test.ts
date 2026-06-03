import { describe, expect, it } from 'vitest';
import {
  reconcileWalletPositions,
  renderReconciliationReport,
  type ReconciliationResult,
} from '../src/execution/walletReconciler.js';
import type { PaperPosition, TokenCandidate } from '../src/types/domain.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

const WALLET = 'WalletPubkey111111111111111111111111111111111';
const RPC_URL = 'https://rpc.example.com';

// Build a minimal PaperPosition for a given mint.
function makePosition(mint: string, symbol: string, quantity: number): PaperPosition {
  const token: TokenCandidate = {
    chain: 'solana',
    address: mint,
    symbol,
    name: symbol,
    pairAddress: `pair-${mint}`,
    priceUsd: 0.001,
    liquidityUsd: 50_000,
    volume5mUsd: 10_000,
    volume1hUsd: 50_000,
    priceChange5mPct: 10,
    buys5m: 50,
    sells5m: 20,
    ageMinutes: 15,
    source: 'test',
    routeAvailable: true,
    estimatedSlippageBps: 100,
  };
  return {
    id: `live-1-${mint}`,
    token,
    score: 80,
    entryPriceUsd: 0.001,
    quantity,
    openedAt: new Date('2026-01-01'),
    highWaterMarkUsd: 0.001,
    lastMarkUsd: 0.001,
  };
}

// Build a fake fetchFn that returns a predefined token account set.
function makeFetchFn(accounts: Array<{ mint: string; uiAmount: number }>) {
  return async (_url: string | URL | Request, _options?: RequestInit): Promise<Response> => {
    const body = JSON.stringify({
      result: {
        value: accounts.map(({ mint, uiAmount }) => ({
          pubkey: `TokenAccount-${mint}`,
          account: {
            data: {
              parsed: {
                info: {
                  mint,
                  tokenAmount: { amount: String(Math.round(uiAmount * 1e6)), decimals: 6, uiAmount },
                },
              },
            },
          },
        })),
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function makeFetchError() {
  return async (_url: string | URL | Request, _options?: RequestInit): Promise<Response> =>
    new Response('Server error', { status: 500 });
}

// ─── reconcileWalletPositions ─────────────────────────────────────────────────

describe('reconcileWalletPositions', () => {
  it('reports no discrepancies when positions match on-chain balances', async () => {
    const positions = [makePosition('mint-abc', 'PUMP', 25_000)];
    const result = await reconcileWalletPositions({
      walletPublicKey: WALLET,
      openPositions: positions,
      rpcUrl: RPC_URL,
      fetchFn: makeFetchFn([{ mint: 'mint-abc', uiAmount: 25_000 }]),
    });

    expect(result.orphaned).toHaveLength(0);
    expect(result.stale).toHaveLength(0);
    expect(result.matched).toBe(1);
    expect(result.error).toBeUndefined();
  });

  it('detects an orphaned holding: token in wallet but not in SQLite', async () => {
    const result = await reconcileWalletPositions({
      walletPublicKey: WALLET,
      openPositions: [],
      rpcUrl: RPC_URL,
      fetchFn: makeFetchFn([{ mint: 'mint-orphan', uiAmount: 10_000 }]),
    });

    expect(result.orphaned).toHaveLength(1);
    expect(result.orphaned[0].mint).toBe('mint-orphan');
    expect(result.orphaned[0].uiAmount).toBe(10_000);
    expect(result.stale).toHaveLength(0);
  });

  it('detects a stale position: in SQLite but no on-chain balance', async () => {
    const positions = [makePosition('mint-gone', 'GONE', 25_000)];
    const result = await reconcileWalletPositions({
      walletPublicKey: WALLET,
      openPositions: positions,
      rpcUrl: RPC_URL,
      fetchFn: makeFetchFn([]), // wallet is empty
    });

    expect(result.stale).toHaveLength(1);
    expect(result.stale[0].mint).toBe('mint-gone');
    expect(result.stale[0].actualUiAmount).toBe(0);
    expect(result.orphaned).toHaveLength(0);
  });

  it('excludes known stablecoins from orphaned report', async () => {
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY2Sr6MGt9RktwD';
    const result = await reconcileWalletPositions({
      walletPublicKey: WALLET,
      openPositions: [],
      rpcUrl: RPC_URL,
      fetchFn: makeFetchFn([
        { mint: USDC, uiAmount: 500 },
        { mint: USDT, uiAmount: 200 },
      ]),
    });

    expect(result.orphaned).toHaveLength(0);
  });

  it('excludes dust amounts (< 0.001) from orphaned and stale checks', async () => {
    const positions = [makePosition('mint-dust-pos', 'DUSTPOS', 25_000)];
    const result = await reconcileWalletPositions({
      walletPublicKey: WALLET,
      openPositions: positions,
      rpcUrl: RPC_URL,
      fetchFn: makeFetchFn([
        { mint: 'mint-dust-orphan', uiAmount: 0.0005 },  // dust — excluded from orphaned
        { mint: 'mint-dust-pos', uiAmount: 0.0005 },    // dust — stale (less than 1% of 25000)
      ]),
    });

    expect(result.orphaned).toHaveLength(0); // orphan excluded due to dust
    expect(result.stale).toHaveLength(1);    // position is stale (dust < 1% of 25000)
  });

  it('treats balance >= 1% of expected quantity as matched (fill tolerance)', async () => {
    const positions = [makePosition('mint-partial', 'PART', 1_000)];
    const result = await reconcileWalletPositions({
      walletPublicKey: WALLET,
      openPositions: positions,
      rpcUrl: RPC_URL,
      // 15 tokens = 1.5% of 1000 — above the 1% threshold → matched
      fetchFn: makeFetchFn([{ mint: 'mint-partial', uiAmount: 15 }]),
    });

    expect(result.matched).toBe(1);
    expect(result.stale).toHaveLength(0);
  });

  it('returns error when RPC call fails', async () => {
    const result = await reconcileWalletPositions({
      walletPublicKey: WALLET,
      openPositions: [],
      rpcUrl: RPC_URL,
      fetchFn: makeFetchError(),
    });

    expect(result.error).toBeDefined();
    expect(result.orphaned).toHaveLength(0);
    expect(result.stale).toHaveLength(0);
  });

  it('handles mixed: matched + orphaned + stale in one pass', async () => {
    const positions = [
      makePosition('mint-ok', 'OK', 10_000),
      makePosition('mint-stale', 'STALE', 5_000),
    ];
    const result = await reconcileWalletPositions({
      walletPublicKey: WALLET,
      openPositions: positions,
      rpcUrl: RPC_URL,
      fetchFn: makeFetchFn([
        { mint: 'mint-ok', uiAmount: 10_000 },     // matched
        { mint: 'mint-orphan', uiAmount: 2_000 },  // orphaned
        // mint-stale intentionally absent                // stale
      ]),
    });

    expect(result.matched).toBe(1);
    expect(result.orphaned).toHaveLength(1);
    expect(result.orphaned[0].mint).toBe('mint-orphan');
    expect(result.stale).toHaveLength(1);
    expect(result.stale[0].mint).toBe('mint-stale');
  });
});

// ─── renderReconciliationReport ──────────────────────────────────────────────

describe('renderReconciliationReport', () => {
  const clean: ReconciliationResult = { orphaned: [], stale: [], matched: 3 };
  const withIssues: ReconciliationResult = {
    orphaned: [{ mint: 'mint-A', uiAmount: 5000 }],
    stale: [{ positionId: 'live-1', mint: 'mint-B', symbol: 'GONE', expectedQuantity: 25_000, actualUiAmount: 0 }],
    matched: 1,
  };

  it('returns OK line when all positions are matched', () => {
    const report = renderReconciliationReport(clean);
    expect(report).toContain('[reconcile] OK');
    expect(report).toContain('3 position');
  });

  it('returns empty string when no positions and no issues', () => {
    const report = renderReconciliationReport({ orphaned: [], stale: [], matched: 0 });
    expect(report).toBe('');
  });

  it('includes ORPHANED lines when orphaned holdings exist', () => {
    const report = renderReconciliationReport(withIssues);
    expect(report).toContain('ORPHANED');
    expect(report).toContain('mint-A');
  });

  it('includes STALE lines when stale positions exist', () => {
    const report = renderReconciliationReport(withIssues);
    expect(report).toContain('STALE');
    expect(report).toContain('GONE');
    expect(report).toContain('live-1');
    expect(report).toContain('quarantine');
  });

  it('surfaces RPC errors clearly', () => {
    const errResult: ReconciliationResult = { orphaned: [], stale: [], matched: 0, error: 'HTTP 503' };
    const report = renderReconciliationReport(errResult);
    expect(report).toContain('WARNING');
    expect(report).toContain('HTTP 503');
  });
});
