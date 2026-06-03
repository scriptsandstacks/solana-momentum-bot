import { describe, expect, it, vi } from 'vitest';
import { LiveBroker, type LiveBrokerDeps, type LiveBrokerOptions } from '../src/execution/liveBroker.js';
import type { TokenCandidate } from '../src/types/domain.js';
import type { LiveExecutionJournalStore } from '../src/execution/liveExecutionJournal.js';

// ─── fixtures ───────────────────────────────────────────────────────────────

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

const defaultOptions: LiveBrokerOptions = {
  solana: {
    enabled: true,
    walletFile: './wallet/chain-solana.txt',
    rpcUrlEnv: 'SOLANA_RPC_URL',
    minLiquidityUsd: 10_000,
    minVolume5mUsd: 5_000,
    maxSlippageBps: 500,
  },
  positionSizeUsd: 25,
  maxOpenPositions: 3,
  maxDailyLossUsd: 100,
};

function makeCandidate(overrides: Partial<TokenCandidate> = {}): TokenCandidate {
  return {
    chain: 'solana',
    address: 'token-mint-abc123',
    symbol: 'PUMP',
    name: 'Pump Token',
    pairAddress: 'pair-1',
    priceUsd: 0.001,
    liquidityUsd: 50_000,
    volume5mUsd: 20_000,
    volume1hUsd: 100_000,
    priceChange5mPct: 15,
    buys5m: 80,
    sells5m: 20,
    ageMinutes: 10,
    source: 'pumpportal',
    routeAvailable: true,
    estimatedSlippageBps: 150,
    routeInputMint: USDC_MINT,
    routeInputSymbol: 'USDC',
    ...overrides,
  };
}

// Build quote-like object Jupiter would return for an ExactIn USDC→token swap
function makeQuote(inAmount: string, outAmount: string, inputMint = USDC_MINT, outputMint = 'token-mint-abc123') {
  return {
    inputMint,
    inAmount,
    outputMint,
    outAmount,
    slippageBps: 500,
    priceImpactPct: '0.5',
    otherAmountThreshold: outAmount,
    swapMode: 'ExactIn',
    routePlan: [],
  };
}

// A set of fully-wired mock deps. Tests can override individual functions.
function makeDeps(overrides: Partial<LiveBrokerDeps> = {}): LiveBrokerDeps {
  // 25 USDC in → 25_000 tokens out (token price = 0.001 USDC)
  const buyQuote = makeQuote('25000000', '25000000000'); // 25 USDC → 25B base units (6-decimal token)
  const sellQuote = makeQuote('25000000000', '24875000', 'token-mint-abc123', USDC_MINT); // sell → ~24.875 USDC

  return {
    getPublicKey: () => 'wallet-pubkey-1111',
    getSolPriceUsd: async () => 150,
    getTokenDecimals: async (mint) => (mint === USDC_MINT ? 6 : 6),
    getJupiterQuote: async ({ outputMint }) =>
      outputMint === 'token-mint-abc123' ? (buyQuote as any) : (sellQuote as any),
    getSwapTransaction: async () => ({ swapTransaction: Buffer.from('fake-tx').toString('base64') }),
    signAndSendTransaction: async () => 'sig-abc123',
    confirmTransaction: async () => {},
    getConfirmedSwapFill: async ({ outputMint }) =>
      outputMint === 'token-mint-abc123'
        ? { inputAmount: 25_000_000n, outputAmount: 25_000_000_000n, networkFeeLamports: 5_000 }
        : { inputAmount: 25_000_000_000n, outputAmount: 24_875_000n, networkFeeLamports: 5_000 },
    ...overrides,
  };
}

function makeBroker(
  opts: Partial<LiveBrokerOptions> = {},
  deps: Partial<LiveBrokerDeps> = {},
  initialCashUsd = 500,
  journal?: LiveExecutionJournalStore,
): LiveBroker {
  return new LiveBroker({ ...defaultOptions, ...opts }, makeDeps(deps), {
    openPositions: [],
    realizedPnlUsd: 0,
    dailyRealizedPnlUsd: 0,
    nextPositionSeq: 1,
    initialCashUsd,
  }, journal);
}

function makeJournal(): LiveExecutionJournalStore & {
  prepared: any[];
  submitted: any[];
  confirmed: string[];
  failed: any[];
} {
  const journal = {
    prepared: [] as any[],
    submitted: [] as any[],
    confirmed: [] as string[],
    failed: [] as any[],
    recordLiveExecutionPrepared(entry: any) { journal.prepared.push(entry); },
    recordLiveExecutionSubmitted(id: string, signature: string, lastValidBlockHeight?: number) {
      journal.submitted.push({ id, signature, lastValidBlockHeight });
    },
    recordLiveExecutionConfirmed(id: string) { journal.confirmed.push(id); },
    recordLiveExecutionFailed(id: string, error: string) { journal.failed.push({ id, error }); },
  };
  return journal;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('LiveBroker.mode', () => {
  it('reports live mode', () => {
    expect(makeBroker().mode).toBe('live');
  });
});

describe('LiveBroker.canOpenPosition', () => {
  it('passes when everything is configured and funds are available', () => {
    expect(makeBroker().canOpenPosition()).toMatchObject({ ok: true });
  });

  it('blocks when walletFile is not configured', () => {
    const broker = makeBroker({ solana: { ...defaultOptions.solana, walletFile: undefined } });
    expect(broker.canOpenPosition()).toMatchObject({ ok: false, reason: expect.stringContaining('walletFile') });
  });

  it('blocks when max open positions is reached', () => {
    const broker = makeBroker({ maxOpenPositions: 0 });
    expect(broker.canOpenPosition()).toMatchObject({ ok: false, reason: expect.stringContaining('max open positions') });
  });

  it('blocks new entries while a stale live position is quarantined', async () => {
    const broker = makeBroker();
    const position = await broker.openPosition(makeCandidate(), 80);

    expect(broker.quarantinePositions([position.id])).toBe(1);
    expect(broker.canOpenPosition()).toMatchObject({ ok: false, reason: expect.stringContaining('recover-positions') });
  });

  it('blocks when cash is insufficient', () => {
    const broker = makeBroker({}, {}, 10); // only $10, needs $25
    expect(broker.canOpenPosition()).toMatchObject({ ok: false, reason: expect.stringContaining('insufficient funds') });
  });

  it('blocks when daily loss limit is hit', () => {
    const broker = new LiveBroker(defaultOptions, makeDeps(), {
      openPositions: [],
      realizedPnlUsd: -120,
      dailyRealizedPnlUsd: -100,
      dailyRealizedPnlAt: new Date(),
      nextPositionSeq: 1,
      initialCashUsd: 500,
    });
    expect(broker.canOpenPosition()).toMatchObject({ ok: false, reason: expect.stringContaining('daily loss') });
  });
});

describe('LiveBroker.openPosition', () => {
  it('requests a quote, builds and sends the swap, and returns a position', async () => {
    const getJupiterQuote = vi.fn(makeDeps().getJupiterQuote);
    const getSwapTransaction = vi.fn(makeDeps().getSwapTransaction);
    const signAndSendTransaction = vi.fn(async () => 'sig-open-1');
    const confirmTransaction = vi.fn(async () => {});

    const broker = makeBroker({}, { getJupiterQuote, getSwapTransaction, signAndSendTransaction, confirmTransaction });
    const candidate = makeCandidate();
    const position = await broker.openPosition(candidate, 82);

    expect(position.id).toMatch(/^live-/);
    expect(position.token.address).toBe('token-mint-abc123');
    expect(position.score).toBe(82);
    expect(position.quantity).toBeGreaterThan(0);
    expect(position.entryPriceUsd).toBeGreaterThan(0);

    expect(getJupiterQuote).toHaveBeenCalledOnce();
    expect(signAndSendTransaction).toHaveBeenCalledWith(expect.any(String));
    expect(confirmTransaction).toHaveBeenCalledWith('sig-open-1', undefined);
  });

  it('journals open execution through confirmation', async () => {
    const journal = makeJournal();
    const broker = makeBroker({}, {}, 500, journal);

    const position = await broker.openPosition(makeCandidate(), 80);

    expect(journal.prepared).toHaveLength(1);
    expect(journal.prepared[0]).toMatchObject({ side: 'open', positionId: position.id, mint: 'token-mint-abc123' });
    expect(journal.submitted[0]).toMatchObject({ signature: 'sig-abc123' });
    expect(journal.confirmed).toEqual([journal.prepared[0].id]);
    expect(journal.failed).toHaveLength(0);
  });

  it('leaves a confirmed journal entry incomplete when fill parsing fails', async () => {
    const journal = makeJournal();
    const broker = makeBroker({}, {
      getConfirmedSwapFill: async () => { throw new Error('receipt unavailable'); },
    }, 500, journal);

    await expect(broker.openPosition(makeCandidate(), 80)).rejects.toThrow('receipt unavailable');

    expect(journal.confirmed).toEqual([journal.prepared[0].id]);
    expect(journal.failed).toHaveLength(0);
  });

  it('leaves a submitted journal entry incomplete when confirmation is uncertain', async () => {
    const journal = makeJournal();
    const broker = makeBroker({}, {
      confirmTransaction: async () => { throw new Error('RPC timeout'); },
    }, 500, journal);

    await expect(broker.openPosition(makeCandidate(), 80)).rejects.toThrow('RPC timeout');

    expect(journal.submitted).toHaveLength(1);
    expect(journal.confirmed).toHaveLength(0);
    expect(journal.failed).toHaveLength(0);
  });

  it('uses SOL pricing when routeInputMint is SOL', async () => {
    const getSolPriceUsd = vi.fn(async () => 200); // $200/SOL
    const getJupiterQuote = vi.fn(async ({ inputMint, outputMint }: any) => {
      if (outputMint === 'token-mint-abc123') {
        // SOL → token: 0.125 SOL in (25 USD / 200 USD/SOL), 25_000 tokens out
        return makeQuote('125000000', '25000000000', SOL_MINT, 'token-mint-abc123') as any;
      }
      return makeQuote('25000000000', '24875000', 'token-mint-abc123', USDC_MINT) as any;
    });

    const broker = makeBroker({}, { getSolPriceUsd, getJupiterQuote });
    const candidate = makeCandidate({ routeInputMint: SOL_MINT, routeInputSymbol: 'SOL' });
    const position = await broker.openPosition(candidate, 80);

    expect(position.quantity).toBeGreaterThan(0);
    // Input amount should be ~0.125 SOL in lamports = 125_000_000
    const [quoteCall] = getJupiterQuote.mock.calls;
    expect(quoteCall[0].inputMint).toBe(SOL_MINT);
    expect(quoteCall[0].amount).toBeCloseTo(125_000_000, -3);
  });

  it('attaches entry tx signature to the returned position', async () => {
    const broker = makeBroker({}, { signAndSendTransaction: async () => 'sig-entry-xyz' });
    const position = await broker.openPosition(makeCandidate(), 80);
    expect(position.entryTxSignature).toBe('sig-entry-xyz');
  });

  it('passes Jupiter lastValidBlockHeight into confirmation', async () => {
    const confirmTransaction = vi.fn(async () => {});
    const broker = makeBroker({}, {
      getSwapTransaction: async () => ({
        swapTransaction: Buffer.from('fake-tx').toString('base64'),
        lastValidBlockHeight: 12345,
      }),
      confirmTransaction,
    });

    await broker.openPosition(makeCandidate(), 80);

    expect(confirmTransaction).toHaveBeenCalledWith('sig-abc123', 12345);
  });

  it('uses the confirmed balance deltas instead of the quoted output', async () => {
    const broker = makeBroker({}, {
      getConfirmedSwapFill: async () => ({
        inputAmount: 25_000_000n,
        outputAmount: 20_000_000_000n,
        networkFeeLamports: 5_000,
      }),
    });

    const position = await broker.openPosition(makeCandidate(), 80);

    expect(position.quantity).toBe(20_000);
    expect(position.entryPriceUsd).toBeCloseTo(0.00125);
  });

  it('persists the entry network fee and deducts it from cash', async () => {
    const broker = makeBroker({}, {
      getSolPriceUsd: async () => 200,
      getConfirmedSwapFill: async () => ({
        inputAmount: 25_000_000n,
        outputAmount: 25_000_000_000n,
        networkFeeLamports: 10_000,
      }),
    });

    const position = await broker.openPosition(makeCandidate(), 80);

    expect(position.entryNetworkFeeUsd).toBeCloseTo(0.002);
    expect(position.entryNetworkFeeLamports).toBe(10_000);
    expect(broker.getCashUsd()).toBeCloseTo(474.998);
  });

  it('still records a confirmed position when the network fee cannot be valued', async () => {
    const getSolPriceUsd = vi.fn()
      .mockRejectedValueOnce(new Error('price unavailable'));
    const broker = makeBroker({}, { getSolPriceUsd });

    const position = await broker.openPosition(makeCandidate(), 80);

    expect(position.entryNetworkFeeUsd).toBeUndefined();
    expect(position.entryNetworkFeeLamports).toBe(5_000);
    expect(broker.getOpenPositions()).toHaveLength(1);
  });

  it('deducts position cost from cash', async () => {
    const broker = makeBroker();
    const before = broker.getCashUsd();
    await broker.openPosition(makeCandidate(), 80);
    expect(broker.getCashUsd()).toBeLessThan(before);
  });

  it('increments open position count', async () => {
    const broker = makeBroker();
    await broker.openPosition(makeCandidate(), 80);
    expect(broker.getOpenPositions()).toHaveLength(1);
  });

  it('throws when Jupiter returns no buy route', async () => {
    const broker = makeBroker({}, { getJupiterQuote: async () => undefined });
    await expect(broker.openPosition(makeCandidate(), 80)).rejects.toThrow('No Jupiter buy route');
  });

  it('throws when execution deps are absent', async () => {
    const broker = new LiveBroker(defaultOptions, {}, { openPositions: [], realizedPnlUsd: 0, dailyRealizedPnlUsd: 0, nextPositionSeq: 1, initialCashUsd: 500 });
    await expect(broker.openPosition(makeCandidate(), 80)).rejects.toThrow('execution deps are not configured');
  });
});

describe('LiveBroker.closePosition', () => {
  it('submits a sell swap and returns a trade with on-chain fill price', async () => {
    const signAndSendTransaction = vi.fn(async () => 'sig-close-1');
    const confirmTransaction = vi.fn(async () => {});
    const broker = makeBroker({}, { signAndSendTransaction, confirmTransaction });

    const position = await broker.openPosition(makeCandidate(), 80);
    const trade = await broker.closePosition(position.id, 0.0011, 'trailing_stop');

    expect(trade.positionId).toBe(position.id);
    expect(trade.reason).toBe('trailing_stop');
    expect(trade.exitPriceSource).toBe('fresh');
    // sell quote returns 24_875_000 USDC base units = 24.875 USDC
    expect(trade.exitPriceUsd).toBeCloseTo(24.875 / position.quantity, 4);
    expect(trade.pnlUsd).toBeDefined();
    expect(trade.closedAt).toBeInstanceOf(Date);

    expect(signAndSendTransaction).toHaveBeenCalledTimes(2); // buy + sell
    expect(confirmTransaction).toHaveBeenCalledWith('sig-close-1', undefined);
  });

  it('journals close execution through confirmation', async () => {
    const journal = makeJournal();
    const broker = makeBroker({}, {}, 500, journal);
    const position = await broker.openPosition(makeCandidate(), 80);
    journal.prepared.length = 0;
    journal.submitted.length = 0;
    journal.confirmed.length = 0;

    await broker.closePosition(position.id, 0.001, 'manual');

    expect(journal.prepared[0]).toMatchObject({ side: 'close', positionId: position.id, mint: 'token-mint-abc123' });
    expect(journal.submitted[0]).toMatchObject({ signature: 'sig-abc123' });
    expect(journal.confirmed).toEqual([journal.prepared[0].id]);
  });

  it('attaches exit tx signature to the returned trade', async () => {
    const broker = makeBroker({}, { signAndSendTransaction: vi.fn().mockResolvedValueOnce('sig-buy').mockResolvedValueOnce('sig-sell-abc') });
    const position = await broker.openPosition(makeCandidate(), 80);
    const trade = await broker.closePosition(position.id, 0.001, 'stop_loss');
    expect(trade.exitTxSignature).toBe('sig-sell-abc');
  });

  it('uses confirmed USDC proceeds instead of the quoted output', async () => {
    const getConfirmedSwapFill = vi.fn()
      .mockResolvedValueOnce({
        inputAmount: 25_000_000n,
        outputAmount: 25_000_000_000n,
        networkFeeLamports: 5_000,
      })
      .mockResolvedValueOnce({
        inputAmount: 25_000_000_000n,
        outputAmount: 20_000_000n,
        networkFeeLamports: 5_000,
      });
    const broker = makeBroker({}, { getConfirmedSwapFill });

    const position = await broker.openPosition(makeCandidate(), 80);
    const trade = await broker.closePosition(position.id, 0.001, 'stop_loss');

    expect(trade.exitPriceUsd).toBeCloseTo(0.0008);
    expect(trade.pnlUsd).toBeCloseTo(-5);
  });

  it('includes entry and exit Solana network fees in realized PnL', async () => {
    const getConfirmedSwapFill = vi.fn()
      .mockResolvedValueOnce({
        inputAmount: 25_000_000n,
        outputAmount: 25_000_000_000n,
        networkFeeLamports: 10_000,
      })
      .mockResolvedValueOnce({
        inputAmount: 25_000_000_000n,
        outputAmount: 25_000_000n,
        networkFeeLamports: 20_000,
      });
    const broker = makeBroker({}, { getSolPriceUsd: async () => 200, getConfirmedSwapFill });

    const position = await broker.openPosition(makeCandidate(), 80);
    const trade = await broker.closePosition(position.id, 0.001, 'manual');

    expect(trade.entryNetworkFeeUsd).toBeCloseTo(0.002);
    expect(trade.exitNetworkFeeUsd).toBeCloseTo(0.004);
    expect(trade.entryNetworkFeeLamports).toBe(10_000);
    expect(trade.exitNetworkFeeLamports).toBe(20_000);
    expect(trade.pnlUsd).toBeCloseTo(-0.006);
    expect(trade.pnlPct).toBeCloseTo((-0.006 / 25.002) * 100);
  });

  it('records trade in getClosedTrades()', async () => {
    const broker = makeBroker();
    const position = await broker.openPosition(makeCandidate(), 80);
    await broker.closePosition(position.id, 0.001, 'stop_loss');
    expect(broker.getClosedTrades()).toHaveLength(1);
    expect(broker.getClosedTrades()[0].positionId).toBe(position.id);
  });

  it('removes position from open positions after close', async () => {
    const broker = makeBroker();
    const position = await broker.openPosition(makeCandidate(), 80);
    await broker.closePosition(position.id, 0.001, 'stop_loss');
    expect(broker.getOpenPositions()).toHaveLength(0);
  });

  it('updates realized PnL after close', async () => {
    const broker = makeBroker();
    const position = await broker.openPosition(makeCandidate(), 80);
    await broker.closePosition(position.id, 0.001, 'stop_loss');
    // Realized PnL should be non-zero (buy 25 USDC, sell ~24.875 USDC)
    expect(broker.getRealizedPnlUsd()).not.toBe(0);
  });

  it('throws on unknown position id', async () => {
    const broker = makeBroker();
    await expect(broker.closePosition('non-existent', 0.001, 'stop_loss')).rejects.toThrow('unknown position');
  });

  it('throws when Jupiter returns no sell route', async () => {
    const broker = makeBroker({}, {
      getJupiterQuote: vi.fn(async ({ outputMint }: any) => {
        // Buy quote succeeds, sell quote fails
        if (outputMint === 'token-mint-abc123') return makeQuote('25000000', '25000000000') as any;
        return undefined;
      }),
    });
    const position = await broker.openPosition(makeCandidate(), 80);
    await expect(broker.closePosition(position.id, 0.001, 'stop_loss')).rejects.toThrow('No Jupiter sell route');
  });
});

describe('LiveBroker.recordMark', () => {
  it('updates lastMark and high-water mark', async () => {
    const broker = makeBroker();
    const position = await broker.openPosition(makeCandidate(), 80);

    const updated = broker.recordMark(position.id, 0.002);
    expect(updated.lastMarkUsd).toBe(0.002);
    expect(updated.highWaterMarkUsd).toBe(0.002);
  });

  it('does not lower the high-water mark', async () => {
    const broker = makeBroker();
    const position = await broker.openPosition(makeCandidate(), 80);

    broker.recordMark(position.id, 0.005);
    const updated = broker.recordMark(position.id, 0.001);
    expect(updated.highWaterMarkUsd).toBe(0.005);
    expect(updated.lastMarkUsd).toBe(0.001);
  });
});

describe('LiveBroker state restoration', () => {
  it('restores open positions and cash from store state', () => {
    const existingPosition = {
      id: 'live-99',
      token: makeCandidate(),
      score: 85,
      entryPriceUsd: 0.001,
      quantity: 25_000,
      openedAt: new Date('2026-01-01'),
      highWaterMarkUsd: 0.0012,
      lastMarkUsd: 0.0011,
      entryNetworkFeeUsd: 0.002,
    };

    const broker = new LiveBroker(
      defaultOptions,
      makeDeps(),
      {
        openPositions: [existingPosition],
        realizedPnlUsd: -5,
        dailyRealizedPnlUsd: -5,
        dailyRealizedPnlAt: new Date(),
        nextPositionSeq: 100,
        initialCashUsd: 475,
      },
    );

    expect(broker.getOpenPositions()).toHaveLength(1);
    expect(broker.getOpenPositions()[0].id).toBe('live-99');
    expect(broker.getCashUsd()).toBe(475);
    expect(broker.getRealizedPnlUsd()).toBe(-5);
    expect(broker.getOpenPositions()[0].entryNetworkFeeUsd).toBe(0.002);
  });

  it('excludes quarantined positions from automated position management without deleting them', () => {
    const existingPosition = {
      id: 'live-99',
      token: makeCandidate(),
      score: 85,
      entryPriceUsd: 0.001,
      quantity: 25_000,
      openedAt: new Date('2026-01-01'),
      highWaterMarkUsd: 0.0012,
      lastMarkUsd: 0.0011,
    };
    const broker = new LiveBroker(defaultOptions, makeDeps(), {
      openPositions: [existingPosition],
      nextPositionSeq: 100,
      initialCashUsd: 475,
    });

    expect(broker.quarantinePositions(['live-99', 'missing-position'])).toBe(1);
    expect(broker.quarantinePositions(['live-99'])).toBe(0);
    expect(broker.getOpenPositions()).toHaveLength(0);
    expect(broker.canOpenPosition()).toMatchObject({ ok: false, reason: expect.stringContaining('stale live position') });
  });
});
