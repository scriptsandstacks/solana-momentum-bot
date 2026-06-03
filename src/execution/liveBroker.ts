import type { ChainConfig } from '../config/schema.js';
import type { PaperPosition, PaperTrade, TokenCandidate } from '../types/domain.js';
import type { ExecutionBroker } from './broker.js';
import type { BrokerStateStore } from '../paper/restoreBroker.js';
import { startOfUtcDayIso } from '../paper/restoreBroker.js';
import type { JupiterQuoteResponse } from './jupiterSwap.js';
import type { ConfirmedSwapFill } from './solanaTransactionFill.js';
import type { LiveExecutionJournalStore } from './liveExecutionJournal.js';
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

    const { getJupiterQuote, getSwapTransaction, signAndSendTransaction, confirmTransaction, getConfirmedSwapFill, getTokenDecimals, getSolPriceUsd, getPublicKey } = this.deps;
    if (!getJupiterQuote || !getSwapTransaction || !signAndSendTransaction || !confirmTransaction || !getConfirmedSwapFill || !getTokenDecimals || !getSolPriceUsd || !getPublicKey) {
      throw new Error('LiveBroker: execution deps are not configured — use LiveBroker.restore() with createLiveBrokerDeps()');
    }

    const id = `live-${this.nextId++}`;
    // Determine input mint and amount from the pre-computed best route.
    const inputMint = candidate.routeInputMint ?? SOL_MINT;
    const inputAmountBaseUnits = await this.resolveInputAmount(inputMint, sizeUsd, getSolPriceUsd);
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
      // Fresh quote sized exactly to the position.
      const quote = await getJupiterQuote({
        inputMint,
        outputMint: candidate.address,
        amount: inputAmountBaseUnits,
        slippageBps: maxSlippage,
      });
      if (!quote) throw new Error(`No Jupiter buy route for ${candidate.symbol} (${candidate.address})`);

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
        token: candidate,
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

    // Sell the entire tracked token quantity to USDC.
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
      outputMint: USDC_MINT,
      inputAmountBaseUnits: String(tokenAmountBaseUnits),
    });

    let submitted = false;
    let confirmed = false;
    try {
      const quote = await getJupiterQuote({
        inputMint: position.token.address,
        outputMint: USDC_MINT,
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
        outputMint: USDC_MINT,
      });

      // Compute P&L from confirmed USDC wallet balance deltas.
      const usdcReceived = Number(fill.outputAmount) / 1e6;
      const exitNetworkFeeUsd = await this.resolveNetworkFeeUsd(fill.networkFeeLamports, getSolPriceUsd);
      const entryNetworkFeeUsd = position.entryNetworkFeeUsd ?? 0;
      const valuedExitNetworkFeeUsd = exitNetworkFeeUsd ?? 0;
      const netExitPriceUsd = usdcReceived / position.quantity;
      const entryValueUsd = position.entryPriceUsd * position.quantity;
      const totalEntryCostUsd = entryValueUsd + entryNetworkFeeUsd;
      const pnlUsd = usdcReceived - valuedExitNetworkFeeUsd - totalEntryCostUsd;
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
      this.cashUsd += usdcReceived - valuedExitNetworkFeeUsd;
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
    return [...this.openPositions.values()];
  }

  getClosedTrades(): PaperTrade[] {
    return [...this.closedTrades];
  }

  // ─── private helpers ───────────────────────────────────────────────────────

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
