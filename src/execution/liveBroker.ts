import type { ChainConfig } from '../config/schema.js';
import type { PaperPosition, PaperTrade, TokenCandidate } from '../types/domain.js';
import type { ExecutionBroker } from './broker.js';
import type { BrokerStateStore } from '../paper/restoreBroker.js';
import { startOfUtcDayIso } from '../paper/restoreBroker.js';
import type { JupiterQuoteResponse } from './jupiterSwap.js';
import type { ConfirmedSwapFill } from './solanaTransactionFill.js';
import type { LiveExecutionJournalStore } from './liveExecutionJournal.js';
import { DEFAULT_MIN_SOL_FEE_RESERVE_LAMPORTS } from './liveReadiness.js';
import { randomUUID } from 'node:crypto';

// ─── injectable dependencies ────────────────────────────────────────────────
// Every network call the LiveBroker makes is injected so unit tests can run
// without real keys, real RPC, or real Jupiter access.

export interface LiveBrokerDeps {
  // Get a Jupiter quote for an ExactIn swap. Returns undefined when no route.
  getJupiterQuote: (params: {
    inputMint: string;
    outputMint: string;
    amount: number;
    slippageBps: number;
  }) => Promise<JupiterQuoteResponse | undefined>;

  // Build a swap transaction from a quote. Returns the base64 transaction.
  getSwapTransaction: (params: {
    quoteResponse: JupiterQuoteResponse;
    userPublicKey: string;
    wrapAndUnwrapSol: boolean;
  }) => Promise<{ swapTransaction: string; lastValidBlockHeight?: number }>;

  // Sign the base64 transaction with the loaded keypair and submit it.
  // Returns the transaction signature string.
  signAndSendTransaction: (transactionBase64: string) => Promise<string>;

  // Poll until the given signature is confirmed on-chain, or throw on failure.
  confirmTransaction: (signature: string, lastValidBlockHeight?: number) => Promise<void>;

  // Read the confirmed transaction and return the wallet's actual swap balance
  // deltas. Quote amounts are estimates and must not drive live accounting.
  getConfirmedSwapFill: (params: {
    signature: string;
    owner: string;
    inputMint: string;
    outputMint: string;
  }) => Promise<ConfirmedSwapFill>;

  // Return the SPL token decimal precision for a given mint address.
  // Implementations should cache; this may be called multiple times per trade.
  getTokenDecimals: (mint: string) => Promise<number>;

  // Return the current SOL/USD price. Used to size SOL-routed buys.
  getSolPriceUsd: () => Promise<number>;

  // Return the wallet's spendable base-unit balance for a route input mint.
  getWalletBalance: (mint: string) => Promise<bigint>;

  // Return the Base58 public key of the trading wallet.
  getPublicKey: () => string;
}

// ─── options ────────────────────────────────────────────────────────────────

export interface LiveBrokerOptions {
  solana: ChainConfig;
  positionSizeUsd: number;
  maxOpenPositions: number;
  maxDailyLossUsd?: number;
}

export interface LiveBrokerState {
  openPositions: PaperPosition[];
  realizedPnlUsd: number;
  dailyRealizedPnlUsd: number;
  dailyRealizedPnlAt?: Date;
  nextPositionSeq: number;
  // Approximate USD cash on hand (debited on open, credited on close).
  // Initialised from the on-chain balance at broker construction time.
  initialCashUsd: number;
}

// ─── well-known mints ────────────────────────────────────────────────────────

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY2Sr6MGt9RktwD';
const ROUTE_INPUTS = [
  { mint: SOL_MINT },
  { mint: USDC_MINT },
  { mint: USDT_MINT },
] as const;

function routeInputSymbol(mint: string): string | undefined {
  if (mint === SOL_MINT) return 'SOL';
  if (mint === USDC_MINT) return 'USDC';
  if (mint === USDT_MINT) return 'USDT';
  return undefined;
}

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ─── broker ─────────────────────────────────────────────────────────────────

export class LiveBroker implements ExecutionBroker {
  readonly mode = 'live' as const;

  private cashUsd: number;
  private realizedPnlUsd: number;
  private readonly dailyPnlByDay = new Map<string, number>();
  private readonly openPositions = new Map<string, PaperPosition>();
  private readonly quarantinedPositionIds = new Set<string>();
  private readonly closedTrades: PaperTrade[] = [];
  private nextId: number;

  constructor(
    private readonly options: LiveBrokerOptions,
    // Deps are optional here so the factory and tests can construct a LiveBroker
    // without full I/O wiring. openPosition / closePosition will throw if the
    // required deps are absent — the production path uses LiveBroker.restore().
    private readonly deps: Partial<LiveBrokerDeps> = {},
    state?: Partial<LiveBrokerState>,
    private readonly journal?: LiveExecutionJournalStore,
  ) {
    this.cashUsd = state?.initialCashUsd ?? 0;
    this.realizedPnlUsd = state?.realizedPnlUsd ?? 0;
    this.nextId = Math.max(1, state?.nextPositionSeq ?? 1);

    for (const pos of state?.openPositions ?? []) {
      this.openPositions.set(pos.id, pos);
    }
    if (state?.dailyRealizedPnlUsd && state.dailyRealizedPnlUsd !== 0) {
      const dayKey = utcDayKey(state.dailyRealizedPnlAt ?? new Date());
      this.dailyPnlByDay.set(dayKey, state.dailyRealizedPnlUsd);
    }
  }

  // Restore from a BrokerStateStore plus an on-chain cash balance snapshot.
  // Call this at run-loop start rather than reconstructing every pass — the
  // LiveBroker is long-lived and holds the keypair/RPC connection via deps.
  static restore(
    store: BrokerStateStore,
    options: LiveBrokerOptions,
    deps: LiveBrokerDeps,
    initialCashUsd: number,
    now = new Date(),
  ): LiveBroker {
    const sinceIso = startOfUtcDayIso(now);
    const journal = isLiveExecutionJournalStore(store) ? store : undefined;
    return new LiveBroker(options, deps, {
      openPositions: store.loadOpenPositions(),
      realizedPnlUsd: store.getRealizedPnlUsd(),
      dailyRealizedPnlUsd: store.getRealizedPnlUsdSince(sinceIso),
      dailyRealizedPnlAt: now,
      nextPositionSeq: store.getNextPositionSeq(),
      initialCashUsd,
    }, journal);
  }

  canOpenPosition(now = new Date(), requiredSizeUsd?: number): { ok: boolean; reason?: string } {
    if (!this.options.solana.walletFile) {
      return { ok: false, reason: 'chains.solana.walletFile is not configured' };
    }

    if (this.quarantinedPositionIds.size > 0) {
      return {
        ok: false,
        reason: `${this.quarantinedPositionIds.size} stale live position(s) require recover-positions`,
      };
    }

    if (this.openPositions.size >= this.options.maxOpenPositions) {
      return { ok: false, reason: `max open positions (${this.options.maxOpenPositions}) reached` };
    }

    const required = requiredSizeUsd ?? this.options.positionSizeUsd;
    if (this.cashUsd < required) {
      return { ok: false, reason: `insufficient funds: have $${this.cashUsd.toFixed(2)}, need $${required.toFixed(2)}` };
    }

    if (this.options.maxDailyLossUsd !== undefined) {
      const todayPnl = this.dailyPnlByDay.get(utcDayKey(now)) ?? 0;
      if (todayPnl <= -this.options.maxDailyLossUsd) {
        return { ok: false, reason: `daily loss limit ($${this.options.maxDailyLossUsd}) reached` };
      }
    }

    return { ok: true };
  }

  async openPosition(
    candidate: TokenCandidate,
    score: number,
    openedAt = new Date(),
    positionSizeUsd?: number,
  ): Promise<PaperPosition> {
    const check = this.canOpenPosition(openedAt, positionSizeUsd);
    if (!check.ok) throw new Error(`Cannot open position: ${check.reason}`);
    if (candidate.priceUsd <= 0) throw new Error('Cannot open position: candidate price must be positive');

    const sizeUsd = positionSizeUsd ?? this.options.positionSizeUsd;
    const maxSlippage = this.options.solana.maxSlippageBps;

    const { getJupiterQuote, getSwapTransaction, signAndSendTransaction, confirmTransaction, getConfirmedSwapFill, getTokenDecimals, getSolPriceUsd, getWalletBalance, getPublicKey } = this.deps;
    if (!getJupiterQuote || !getSwapTransaction || !signAndSendTransaction || !confirmTransaction || !getConfirmedSwapFill || !getTokenDecimals || !getSolPriceUsd || !getWalletBalance || !getPublicKey) {
      throw new Error('LiveBroker: execution deps are not configured — use LiveBroker.restore() with createLiveBrokerDeps()');
    }
    await this.assertSolFeeReserveForOpen(getWalletBalance);

    const id = `live-${this.nextId++}`;
    // Discovery-time route probes are small and wallet-agnostic. Re-quote the
    // actual position size across funded inputs so live execution uses the best
    // route the wallet can really pay for.
    const { inputMint, inputAmountBaseUnits, quote } = await this.selectFundedBuyRoute(
      candidate,
      sizeUsd,
      maxSlippage,
      getWalletBalance,
      getSolPriceUsd,
      getJupiterQuote,
    );
    const journalId = `open:${id}:${randomUUID()}`;
    this.journal?.recordLiveExecutionPrepared({
      id: journalId,
      side: 'open',
      positionId: id,
      mint: candidate.address,
      symbol: candidate.symbol,
      inputMint,
      outputMint: candidate.address,
      inputAmountBaseUnits: String(inputAmountBaseUnits),
    });

    let submitted = false;
    let confirmed = false;
    try {
      // Build → sign → submit → confirm.
      const { swapTransaction, lastValidBlockHeight } = await getSwapTransaction({
        quoteResponse: quote,
        userPublicKey: getPublicKey(),
        wrapAndUnwrapSol: true,
      });
      const signature = await signAndSendTransaction(swapTransaction);
      this.journal?.recordLiveExecutionSubmitted(journalId, signature, lastValidBlockHeight);
      submitted = true;
      await confirmTransaction(signature, lastValidBlockHeight);
      this.journal?.recordLiveExecutionConfirmed(journalId);
      confirmed = true;

      const owner = getPublicKey();
      const fill = await getConfirmedSwapFill({
        signature,
        owner,
        inputMint,
        outputMint: candidate.address,
      });

      // Compute the entry basis from confirmed wallet balance deltas.
      const decimals = await getTokenDecimals(candidate.address);
      const tokensReceived = Number(fill.outputAmount) / Math.pow(10, decimals);
      const actualSpentUsd = await this.resolveSpentUsd(inputMint, Number(fill.inputAmount), getSolPriceUsd);
      const entryNetworkFeeUsd = await this.resolveNetworkFeeUsd(fill.networkFeeLamports, getSolPriceUsd);
      const effectiveEntryPriceUsd = actualSpentUsd / tokensReceived;

      const position: PaperPosition = {
        id,
        token: {
          ...candidate,
          routeInputMint: inputMint,
          routeInputSymbol: routeInputSymbol(inputMint) ?? candidate.routeInputSymbol,
        },
        score,
        entryPriceUsd: effectiveEntryPriceUsd,
        quantity: tokensReceived,
        openedAt,
        highWaterMarkUsd: candidate.priceUsd,
        lastMarkUsd: candidate.priceUsd,
        entryTxSignature: signature,
        entryNetworkFeeUsd,
        entryNetworkFeeLamports: fill.networkFeeLamports,
      };

      this.cashUsd -= actualSpentUsd + (entryNetworkFeeUsd ?? 0);
      this.openPositions.set(id, position);
      return position;
    } catch (error) {
      if (!submitted && !confirmed) {
        this.journal?.recordLiveExecutionFailed(journalId, error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  recordMark(positionId: string, priceUsd: number): PaperPosition {
    const position = this.openPositions.get(positionId);
    if (!position) throw new Error(`Cannot update position: unknown position ${positionId}`);
    position.lastMarkUsd = priceUsd;
    if (priceUsd > position.highWaterMarkUsd) {
      position.highWaterMarkUsd = priceUsd;
    }
    return position;
  }

  async closePosition(
    positionId: string,
    _exitPriceUsd: number,
    reason: PaperTrade['reason'],
    closedAt = new Date(),
    _exitPriceSource?: NonNullable<PaperTrade['exitPriceSource']>,
    _exitSlippageBps?: number,
  ): Promise<PaperTrade> {
    const position = this.openPositions.get(positionId);
    if (!position) throw new Error(`Cannot close position: unknown position ${positionId}`);

    const maxSlippage = this.options.solana.maxSlippageBps;

    const { getJupiterQuote, getSwapTransaction, signAndSendTransaction, confirmTransaction, getConfirmedSwapFill, getTokenDecimals, getSolPriceUsd, getPublicKey } = this.deps;
    if (!getJupiterQuote || !getSwapTransaction || !signAndSendTransaction || !confirmTransaction || !getConfirmedSwapFill || !getTokenDecimals || !getSolPriceUsd || !getPublicKey) {
      throw new Error('LiveBroker: execution deps are not configured — use LiveBroker.restore() with createLiveBrokerDeps()');
    }

    // Sell the entire tracked token quantity back to the route input used for entry.
    // Pump.fun AMM routes often exit to SOL even when token->USDC is unavailable.
    const outputMint = position.token.routeInputMint ?? USDC_MINT;
    const decimals = await getTokenDecimals(position.token.address);
    const tokenAmountBaseUnits = Math.round(position.quantity * Math.pow(10, decimals));
    const journalId = `close:${positionId}:${randomUUID()}`;
    this.journal?.recordLiveExecutionPrepared({
      id: journalId,
      side: 'close',
      positionId,
      mint: position.token.address,
      symbol: position.token.symbol,
      inputMint: position.token.address,
      outputMint,
      inputAmountBaseUnits: String(tokenAmountBaseUnits),
    });

    let submitted = false;
    let confirmed = false;
    try {
      const quote = await getJupiterQuote({
        inputMint: position.token.address,
        outputMint,
        amount: tokenAmountBaseUnits,
        slippageBps: maxSlippage,
      });
      if (!quote) throw new Error(`No Jupiter sell route for ${position.token.symbol} (${position.token.address})`);

      const { swapTransaction, lastValidBlockHeight } = await getSwapTransaction({
        quoteResponse: quote,
        userPublicKey: getPublicKey(),
        wrapAndUnwrapSol: true,
      });
      const signature = await signAndSendTransaction(swapTransaction);
      this.journal?.recordLiveExecutionSubmitted(journalId, signature, lastValidBlockHeight);
      submitted = true;
      await confirmTransaction(signature, lastValidBlockHeight);
      this.journal?.recordLiveExecutionConfirmed(journalId);
      confirmed = true;

      const fill = await getConfirmedSwapFill({
        signature,
        owner: getPublicKey(),
        inputMint: position.token.address,
        outputMint,
      });

      // Compute P&L from confirmed wallet balance deltas valued in USD.
      const proceedsUsd = await this.resolveSpentUsd(outputMint, Number(fill.outputAmount), getSolPriceUsd);
      const exitNetworkFeeUsd = await this.resolveNetworkFeeUsd(fill.networkFeeLamports, getSolPriceUsd);
      const entryNetworkFeeUsd = position.entryNetworkFeeUsd ?? 0;
      const valuedExitNetworkFeeUsd = exitNetworkFeeUsd ?? 0;
      const netExitPriceUsd = proceedsUsd / position.quantity;
      const entryValueUsd = position.entryPriceUsd * position.quantity;
      const totalEntryCostUsd = entryValueUsd + entryNetworkFeeUsd;
      const pnlUsd = proceedsUsd - valuedExitNetworkFeeUsd - totalEntryCostUsd;
      const pnlPct = (pnlUsd / totalEntryCostUsd) * 100;

      const trade: PaperTrade = {
        positionId,
        token: position.token,
        score: position.score,
        entryPriceUsd: position.entryPriceUsd,
        exitPriceUsd: netExitPriceUsd,
        quantity: position.quantity,
        openedAt: position.openedAt,
        closedAt,
        reason,
        exitPriceSource: 'fresh',
        pnlUsd,
        pnlPct,
        exitTxSignature: signature,
        entryNetworkFeeUsd,
        exitNetworkFeeUsd,
        entryNetworkFeeLamports: position.entryNetworkFeeLamports,
        exitNetworkFeeLamports: fill.networkFeeLamports,
      };

      this.openPositions.delete(positionId);
      this.closedTrades.push(trade);
      this.cashUsd += proceedsUsd - valuedExitNetworkFeeUsd;
      this.realizedPnlUsd += pnlUsd;
      const dayKey = utcDayKey(closedAt);
      this.dailyPnlByDay.set(dayKey, (this.dailyPnlByDay.get(dayKey) ?? 0) + pnlUsd);

      return trade;
    } catch (error) {
      if (!submitted && !confirmed) {
        this.journal?.recordLiveExecutionFailed(journalId, error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  // Return the Base58 public key of the trading wallet, or undefined when deps
  // were not fully wired (factory-created broker without a real keypair).
  getWalletPublicKey(): string | undefined {
    return this.deps.getPublicKey?.();
  }

  getCashUsd(): number {
    return this.cashUsd;
  }

  getRealizedPnlUsd(): number {
    return this.realizedPnlUsd;
  }

  getDailyRealizedPnlUsd(now = new Date()): number {
    return this.dailyPnlByDay.get(utcDayKey(now)) ?? 0;
  }

  getOpenPositions(): PaperPosition[] {
    return [...this.openPositions.values()].filter((position) => !this.quarantinedPositionIds.has(position.id));
  }

  // Stop automated exit attempts for positions that startup reconciliation
  // proved do not have a meaningful matching wallet balance. The position stays
  // in SQLite and in broker accounting until recover-positions resolves it.
  quarantinePositions(positionIds: string[]): number {
    let added = 0;
    for (const positionId of positionIds) {
      if (this.openPositions.has(positionId) && !this.quarantinedPositionIds.has(positionId)) {
        this.quarantinedPositionIds.add(positionId);
        added += 1;
      }
    }
    return added;
  }

  getClosedTrades(): PaperTrade[] {
    return [...this.closedTrades];
  }

  // ─── private helpers ───────────────────────────────────────────────────────

  private async selectFundedBuyRoute(
    candidate: TokenCandidate,
    sizeUsd: number,
    maxSlippageBps: number,
    getWalletBalance: LiveBrokerDeps['getWalletBalance'],
    getSolPriceUsd: LiveBrokerDeps['getSolPriceUsd'],
    getJupiterQuote: LiveBrokerDeps['getJupiterQuote'],
  ): Promise<{
    inputMint: string;
    inputAmountBaseUnits: number;
    quote: JupiterQuoteResponse;
  }> {
    const preferredMint = candidate.routeInputMint;
    const routes = [...ROUTE_INPUTS].sort((a, b) => {
      if (a.mint === preferredMint) return -1;
      if (b.mint === preferredMint) return 1;
      return 0;
    });
    const fundedQuotes: Array<{
      inputMint: string;
      inputAmountBaseUnits: number;
      quote: JupiterQuoteResponse;
      outputAmount: bigint;
    }> = [];
    let hasFundedInput = false;
    let rejectedForPriceImpact = false;

    for (const route of routes) {
      const walletBalance = await getWalletBalance(route.mint);
      if (walletBalance <= 0n) continue;
      const inputAmountBaseUnits = await this.resolveInputAmount(route.mint, sizeUsd, getSolPriceUsd);
      if (walletBalance < BigInt(inputAmountBaseUnits)) continue;
      if (route.mint === SOL_MINT && walletBalance - BigInt(inputAmountBaseUnits) < this.minSolFeeReserveLamports()) continue;
      hasFundedInput = true;

      const quote = await getJupiterQuote({
        inputMint: route.mint,
        outputMint: candidate.address,
        amount: inputAmountBaseUnits,
        slippageBps: maxSlippageBps,
      });
      if (!quote) continue;
      const priceImpactBps = quotePriceImpactBps(quote);
      const maxPriceImpactBps = this.options.solana.maxPriceImpactBps ?? maxSlippageBps;
      if (priceImpactBps === undefined || priceImpactBps > maxPriceImpactBps) {
        rejectedForPriceImpact = true;
        continue;
      }

      try {
        fundedQuotes.push({
          inputMint: route.mint,
          inputAmountBaseUnits,
          quote,
          outputAmount: BigInt(quote.outAmount),
        });
      } catch {
        // Ignore malformed quote amounts and keep checking funded alternatives.
      }
    }

    fundedQuotes.sort((a, b) => a.outputAmount > b.outputAmount ? -1 : a.outputAmount < b.outputAmount ? 1 : 0);
    const best = fundedQuotes[0];
    if (!best) {
      if (rejectedForPriceImpact) {
        const maxPriceImpactBps = this.options.solana.maxPriceImpactBps ?? maxSlippageBps;
        throw new Error(
          `Cannot open position: actual-size Jupiter buy route exceeds max price impact (${maxPriceImpactBps} bps) ` +
          `for ${candidate.symbol} (${candidate.address})`,
        );
      }
      if (hasFundedInput) {
        throw new Error(`No Jupiter buy route for ${candidate.symbol} (${candidate.address})`);
      }
      throw new Error(`Cannot open position: no funded Jupiter buy route for ${candidate.symbol} (${candidate.address})`);
    }
    return best;
  }

  private async assertSolFeeReserveForOpen(getWalletBalance: LiveBrokerDeps['getWalletBalance']): Promise<void> {
    const reserve = this.minSolFeeReserveLamports();
    if (reserve === 0n) return;
    const solBalance = await getWalletBalance(SOL_MINT);
    if (solBalance < reserve) {
      throw new Error(
        `Cannot open position: SOL fee reserve below configured minimum ` +
        `(${solBalance.toString()} / ${reserve.toString()} lamports)`,
      );
    }
  }

  private minSolFeeReserveLamports(): bigint {
    return BigInt(this.options.solana.minSolFeeReserveLamports ?? DEFAULT_MIN_SOL_FEE_RESERVE_LAMPORTS);
  }

  // Convert a USD position size to the base-unit amount of the input mint.
  private async resolveInputAmount(
    inputMint: string,
    sizeUsd: number,
    getSolPriceUsd: () => Promise<number>,
  ): Promise<number> {
    if (inputMint === USDC_MINT) return Math.round(sizeUsd * 1e6);
    if (inputMint === SOL_MINT) {
      const solPriceUsd = await getSolPriceUsd();
      return Math.round((sizeUsd / solPriceUsd) * 1e9);
    }
    // Unknown stablecoin — assume 6 decimals (covers USDT etc.)
    return Math.round(sizeUsd * 1e6);
  }

  // Convert a base-unit input amount back to USD for entry price accounting.
  private async resolveSpentUsd(
    inputMint: string,
    baseUnits: number,
    getSolPriceUsd: () => Promise<number>,
  ): Promise<number> {
    if (inputMint === USDC_MINT) return baseUnits / 1e6;
    if (inputMint === SOL_MINT) {
      const solPriceUsd = await getSolPriceUsd();
      return (baseUnits / 1e9) * solPriceUsd;
    }
    return baseUnits / 1e6;
  }

  private async resolveNetworkFeeUsd(
    feeLamports: number,
    getSolPriceUsd: () => Promise<number>,
  ): Promise<number | undefined> {
    if (feeLamports <= 0) return 0;
    try {
      return (feeLamports / 1e9) * await getSolPriceUsd();
    } catch {
      // The swap is already confirmed at this point. Do not create an orphaned
      // live position merely because the small SOL fee could not be valued.
      return undefined;
    }
  }
}

function quotePriceImpactBps(quote: JupiterQuoteResponse): number | undefined {
  const priceImpactPct = Number(quote.priceImpactPct);
  if (!Number.isFinite(priceImpactPct) || priceImpactPct < 0) return undefined;
  return Math.round(priceImpactPct * 10_000);
}

function isLiveExecutionJournalStore(store: unknown): store is LiveExecutionJournalStore {
  return (
    typeof store === 'object' &&
    store !== null &&
    typeof (store as LiveExecutionJournalStore).recordLiveExecutionPrepared === 'function' &&
    typeof (store as LiveExecutionJournalStore).recordLiveExecutionSubmitted === 'function' &&
    typeof (store as LiveExecutionJournalStore).recordLiveExecutionConfirmed === 'function' &&
    typeof (store as LiveExecutionJournalStore).recordLiveExecutionFailed === 'function'
  );
}
