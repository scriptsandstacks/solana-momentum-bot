import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../src/storage/sqliteStore.js';
import type { PumpPortalRawEvent } from '../src/discovery/pumpPortal.js';
import type { OpportunityScore, PaperPosition, PaperTrade, TokenCandidate } from '../src/types/domain.js';

const candidate: TokenCandidate = {
  chain: 'solana',
  address: 'token-1',
  symbol: 'MOCK',
  name: 'Mock Token',
  pairAddress: 'pair-1',
  priceUsd: 0.01,
  liquidityUsd: 50_000,
  volume5mUsd: 15_000,
  volume1hUsd: 100_000,
  priceChange5mPct: 8,
  buys5m: 80,
  sells5m: 30,
  ageMinutes: 15,
  source: 'test',
  routeAvailable: true,
  estimatedSlippageBps: 100,
  routeInputSymbol: 'USDC',
  routeInputMint: 'usdc-mint',
};

const score: OpportunityScore = {
  total: 82,
  recommendation: 'paper_trade',
  reasons: ['route_available'],
  risks: [],
};

function createStore(): SqliteStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'solana-trade-engine-'));
  return new SqliteStore(path.join(dir, 'bot.sqlite'));
}

describe('SqliteStore', () => {
  it('saves token candidates with scores and route metadata', () => {
    const store = createStore();

    store.saveScoredCandidate(candidate, score);
    const rows = store.listRecentScores(5);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      chain: 'solana',
      symbol: 'MOCK',
      score: 82,
      recommendation: 'paper_trade',
      routeInputSymbol: 'USDC',
      routeInputMint: 'usdc-mint',
      strategyId: 'freshLaunchMomentum',
    });
    store.close();
  });

  it('persists sellRouteAvailable as a tristate: true=1, false=0, undefined=null', () => {
    const store = createStore();

    store.saveScoredCandidate({ ...candidate, address: 'mint-sell-ok', sellRouteAvailable: true }, score);
    store.saveScoredCandidate({ ...candidate, address: 'mint-honeypot', sellRouteAvailable: false }, score);
    store.saveScoredCandidate({ ...candidate, address: 'mint-unchecked' }, score);

    const rows = store.listRecentScores(10);
    const byMint = Object.fromEntries(rows.map((r) => [r.address, r.sellRouteAvailable]));

    expect(byMint['mint-sell-ok']).toBe(1);
    expect(byMint['mint-honeypot']).toBe(0);
    expect(byMint['mint-unchecked']).toBeNull();
    store.close();
  });

  it('persists authority flags as queryable scored-candidate columns', () => {
    const store = createStore();

    store.saveScoredCandidate(
      {
        ...candidate,
        address: 'mint-authority-held',
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: true,
        top5HolderPct: 85,
        volumeAcceleration5mZ: 2.5,
        volumeAccelerationSamples: 4,
      },
      score,
    );
    store.saveScoredCandidate({ ...candidate, address: 'mint-authority-unknown' }, score);

    const rows = store.listRecentScores(10);
    const byMint = Object.fromEntries(rows.map((r) => [r.address, r]));

    expect(byMint['mint-authority-held']).toMatchObject({
      mintAuthorityRevoked: 0,
      freezeAuthorityRevoked: 1,
      top5HolderPct: 85,
      volumeAcceleration5mZ: 2.5,
      volumeAccelerationSamples: 4,
    });
    expect(byMint['mint-authority-unknown']).toMatchObject({
      mintAuthorityRevoked: null,
      freezeAuthorityRevoked: null,
      top5HolderPct: null,
      volumeAcceleration5mZ: null,
      volumeAccelerationSamples: null,
    });
    store.close();
  });

  it('records volume snapshots for future acceleration scoring', () => {
    const store = createStore();

    store.saveScoredCandidate({ ...candidate, volume5mUsd: 10_000, volume1hUsd: 80_000 }, score);
    store.saveScoredCandidate({ ...candidate, volume5mUsd: 25_000, volume1hUsd: 120_000 }, score);

    const rows = store.listTokenVolumeSnapshots(candidate.address, 10);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      address: candidate.address,
      symbol: 'MOCK',
      strategyId: 'freshLaunchMomentum',
      volume5mUsd: 25_000,
      volume1hUsd: 120_000,
    });
    expect(rows[1]).toMatchObject({ volume5mUsd: 10_000, volume1hUsd: 80_000 });
    expect(store.listRecentTokenVolumeSnapshots({ address: candidate.address, sinceIso: rows[1].observedAt })).toHaveLength(2);
    store.close();
  });

  it('projects queryable risk and acceleration fields into outcome stats', () => {
    const store = createStore();

    store.saveScoredCandidate(
      {
        ...candidate,
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: true,
        top5HolderPct: 85,
        volumeAcceleration5mZ: 2.5,
        volumeAccelerationSamples: 4,
      },
      score,
    );
    const [trackable] = store.listTrackableScoredCandidates(1);
    store.recordScoredOutcome({
      id: trackable.id,
      outcomeHighUsd: 0.018,
      outcomeLowUsd: 0.009,
      outcomeLastUsd: 0.015,
      outcomeLastAt: '2026-01-01T00:05:00.000Z',
      outcomeFirstTakeProfitAt: '2026-01-01T00:03:00.000Z',
      outcomeFirstStopLossAt: null,
      done: true,
    });

    expect(store.loadScoredOutcomeStats()[0]).toMatchObject({
      strategyId: 'freshLaunchMomentum',
      mintAuthorityRevoked: 0,
      freezeAuthorityRevoked: 1,
      top5HolderPct: 85,
      volumeAcceleration5mZ: 2.5,
    });
    store.close();
  });

  it('saves paper positions and closed trades', () => {
    const store = createStore();
    const position: PaperPosition = {
      id: 'paper-1',
      token: candidate,
      score: 82,
      entryPriceUsd: 0.01,
      quantity: 2500,
      openedAt: new Date('2026-01-01T00:00:00Z'),
      highWaterMarkUsd: 0.012,
      entryNetworkFeeUsd: 0.002,
      entryNetworkFeeLamports: 10_000,
    };
    const trade: PaperTrade = {
      positionId: position.id,
      token: candidate,
      score: 82,
      entryPriceUsd: 0.01,
      exitPriceUsd: 0.015,
      quantity: 2500,
      openedAt: position.openedAt,
      closedAt: new Date('2026-01-01T00:05:00Z'),
      reason: 'take_profit',
      exitPriceSource: 'fresh',
      pnlUsd: 12.5,
      pnlPct: 50,
      entryNetworkFeeUsd: 0.002,
      exitNetworkFeeUsd: 0.004,
      entryNetworkFeeLamports: 10_000,
      exitNetworkFeeLamports: 20_000,
    };

    store.saveOpenPosition(position);
    expect(store.listOpenPositions()).toHaveLength(1);

    store.saveClosedTrade(trade);
    expect(store.listOpenPositions()).toHaveLength(0);
    expect(store.listClosedTrades()).toHaveLength(1);
    expect(store.listClosedTrades()[0]).toMatchObject({
      positionId: 'paper-1',
      pnlUsd: 12.5,
      exitPriceSource: 'fresh',
      strategyId: 'freshLaunchMomentum',
      entryNetworkFeeUsd: 0.002,
      exitNetworkFeeUsd: 0.004,
      entryNetworkFeeLamports: 10_000,
      exitNetworkFeeLamports: 20_000,
    });
    // Analytics projection carries the entry score, discovery source, and strategy id.
    const stats = store.loadClosedTradeStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      reason: 'take_profit',
      score: 82,
      source: 'test',
      strategyId: 'freshLaunchMomentum',
      exitPriceSource: 'fresh',
      pnlUsd: 12.5,
    });
    store.close();
  });

  it('records bot runtime status with pipeline health fields', () => {
    const store = createStore();
    const event: PumpPortalRawEvent = {
      source: 'pumpportal',
      eventType: 'new_token',
      tokenMint: 'token-1',
      symbol: 'MOCK',
      raw: { txType: 'create', mint: 'token-1' },
      receivedAt: '2026-01-01T00:00:00.000Z',
    };

    store.savePumpPortalEvent(event);
    store.markPumpPortalEventProcessed(1, 'skipped', 'below configured liquidity threshold');
    store.saveScoredCandidate(candidate, score);
    store.recordBotRuntimeStatus({
      status: 'running',
      lastLoopAt: '2026-01-01T00:00:10.000Z',
      lastProcessPassAt: '2026-01-01T00:00:10.000Z',
      lastExitPassAt: '2026-01-01T00:00:11.000Z',
      lastError: null,
    });

    const status = store.loadBotRuntimeStatus();
    expect(status).toMatchObject({
      id: 'main',
      status: 'running',
      lastLoopAt: '2026-01-01T00:00:10.000Z',
      lastProcessPassAt: '2026-01-01T00:00:10.000Z',
      lastExitPassAt: '2026-01-01T00:00:11.000Z',
      latestRawEventAt: '2026-01-01T00:00:00.000Z',
      latestScoredCandidateAt: expect.any(String),
      pendingEventCount: 0,
      openPositionCount: 0,
    });
    expect(status?.latestProcessedEventAt).toBeTruthy();
    store.close();
  });

  it('lists pending PumpPortal events for trading as newest first plus oldest cleanup', () => {
    const store = createStore();
    for (let i = 1; i <= 10; i += 1) {
      store.savePumpPortalEvent({
        source: 'pumpportal',
        eventType: 'new_token',
        tokenMint: `mint-${i}`,
        symbol: `M${i}`,
        raw: { txType: 'create', mint: `mint-${i}` },
        receivedAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }

    const rows = store.listPendingPumpPortalEventsForTrading(5);

    expect(rows.map((row) => row.id)).toEqual([10, 9, 8, 7, 1]);
    expect(rows.map((row) => row.tokenMint)).toEqual(['mint-10', 'mint-9', 'mint-8', 'mint-7', 'mint-1']);
    store.close();
  });

  it('tracks incomplete live executions and marks them persisted with position writes', () => {
    const store = createStore();
    store.recordLiveExecutionPrepared({
      id: 'open:live-1:test',
      side: 'open',
      positionId: 'live-1',
      mint: candidate.address,
      symbol: candidate.symbol,
      inputMint: 'usdc',
      outputMint: candidate.address,
      inputAmountBaseUnits: '25000000',
    });
    store.recordLiveExecutionSubmitted('open:live-1:test', 'sig-open', 12345);
    store.recordLiveExecutionConfirmed('open:live-1:test');

    expect(store.listIncompleteLiveExecutions()).toMatchObject([{
      side: 'open',
      positionId: 'live-1',
      signature: 'sig-open',
      lastValidBlockHeight: 12345,
      status: 'confirmed',
    }]);

    store.saveOpenPosition({
      id: 'live-1',
      token: candidate,
      score: 82,
      entryPriceUsd: 0.01,
      quantity: 2500,
      openedAt: new Date('2026-01-01T00:00:00Z'),
      highWaterMarkUsd: 0.01,
      entryTxSignature: 'sig-open',
    });

    expect(store.listIncompleteLiveExecutions()).toHaveLength(0);
    store.close();
  });

  it('marks close journal rows persisted with the closed trade transaction', () => {
    const store = createStore();
    store.recordLiveExecutionPrepared({
      id: 'close:live-1:test',
      side: 'close',
      positionId: 'live-1',
      mint: candidate.address,
      symbol: candidate.symbol,
      inputMint: candidate.address,
      outputMint: 'usdc',
      inputAmountBaseUnits: '2500000000',
    });
    store.recordLiveExecutionSubmitted('close:live-1:test', 'sig-close', 23456);
    store.recordLiveExecutionConfirmed('close:live-1:test');

    store.saveClosedTrade({
      positionId: 'live-1',
      token: candidate,
      score: 82,
      entryPriceUsd: 0.01,
      exitPriceUsd: 0.015,
      quantity: 2500,
      openedAt: new Date('2026-01-01T00:00:00Z'),
      closedAt: new Date('2026-01-01T00:05:00Z'),
      reason: 'manual',
      pnlUsd: 12.5,
      pnlPct: 50,
      exitTxSignature: 'sig-close',
    });

    expect(store.listIncompleteLiveExecutions()).toHaveLength(0);
    store.close();
  });

  it('prunes old scored candidates but keeps mints that led to a trade', () => {
    const store = createStore();

    store.saveScoredCandidate({ ...candidate, address: 'mint-traded' }, score);
    store.saveScoredCandidate({ ...candidate, address: 'mint-skipped' }, score);
    // mint-traded was actually traded, so its scored row must be preserved.
    store.saveClosedTrade({
      positionId: 'paper-1',
      token: { ...candidate, address: 'mint-traded' },
      score: 82,
      entryPriceUsd: 0.01,
      exitPriceUsd: 0.015,
      quantity: 2500,
      openedAt: new Date('2026-01-01T00:00:00Z'),
      closedAt: new Date('2026-01-01T00:05:00Z'),
      reason: 'take_profit',
      exitPriceSource: 'fresh',
      pnlUsd: 12.5,
      pnlPct: 50,
    });

    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();

    // Nothing is older than a past cutoff.
    expect(store.countPrunableScoredCandidates(past)).toBe(0);
    expect(store.pruneScoredCandidates(past)).toBe(0);

    // With a future cutoff both rows qualify by age, but the traded mint is kept.
    expect(store.countPrunableScoredCandidates(future)).toBe(1);
    expect(store.pruneScoredCandidates(future)).toBe(1);
    expect(store.listRecentScores(10).map((r) => r.address)).toEqual(['mint-traded']);
    store.close();
  });

  it('makes closing the same position idempotent', () => {
    const store = createStore();
    const position: PaperPosition = {
      id: 'paper-1',
      token: candidate,
      score: 82,
      entryPriceUsd: 0.01,
      quantity: 2500,
      openedAt: new Date('2026-01-01T00:00:00Z'),
      highWaterMarkUsd: 0.012,
    };
    const trade: PaperTrade = {
      positionId: position.id,
      token: candidate,
      entryPriceUsd: 0.01,
      exitPriceUsd: 0.015,
      quantity: 2500,
      openedAt: position.openedAt,
      closedAt: new Date('2026-01-01T00:05:00Z'),
      reason: 'take_profit',
      exitPriceSource: 'fresh',
      pnlUsd: 12.5,
      pnlPct: 50,
    };

    store.saveOpenPosition(position);
    store.saveClosedTrade(trade);
    store.saveClosedTrade({ ...trade, closedAt: new Date('2026-01-01T00:06:00Z') });

    expect(store.listOpenPositions()).toHaveLength(0);
    expect(store.listClosedTrades()).toHaveLength(1);
    expect(store.getRealizedPnlUsd()).toBeCloseTo(12.5);
    store.close();
  });

  it('rehydrates broker state: open positions, realized PnL, and the next id sequence', () => {
    const store = createStore();
    const position: PaperPosition = {
      id: 'paper-3',
      token: candidate,
      score: 82,
      entryPriceUsd: 0.01,
      quantity: 2500,
      openedAt: new Date('2026-01-01T00:00:00Z'),
      highWaterMarkUsd: 0.018,
      lastMarkUsd: 0.016,
      entryNetworkFeeUsd: 0.002,
      entryNetworkFeeLamports: 10_000,
    };
    const closed: PaperTrade = {
      positionId: 'paper-1',
      token: candidate,
      entryPriceUsd: 0.01,
      exitPriceUsd: 0.015,
      quantity: 2500,
      openedAt: new Date('2026-01-01T00:00:00Z'),
      closedAt: new Date('2026-01-01T00:05:00Z'),
      reason: 'take_profit',
      exitPriceSource: 'fresh',
      pnlUsd: 12.5,
      pnlPct: 50,
    };

    store.saveOpenPosition(position);
    store.saveOpenPosition({ ...position, id: 'paper-1' });
    store.saveClosedTrade(closed); // closes paper-1, leaving paper-3 open

    const loaded = store.loadOpenPositions();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      id: 'paper-3',
      highWaterMarkUsd: 0.018,
      lastMarkUsd: 0.016,
      entryNetworkFeeUsd: 0.002,
      entryNetworkFeeLamports: 10_000,
    });
    expect(loaded[0].token).toMatchObject({ address: 'token-1', symbol: 'MOCK' });
    expect(loaded[0].openedAt).toBeInstanceOf(Date);

    expect(store.getRealizedPnlUsd()).toBeCloseTo(12.5);
    expect(store.getRealizedPnlUsdSince('2026-01-01T00:00:00.000Z')).toBeCloseTo(12.5);
    expect(store.getRealizedPnlUsdSince('2026-01-02T00:00:00.000Z')).toBe(0);
    // Highest used seq is paper-3 (open) — paper-1 lives in closed_trades.
    expect(store.getNextPositionSeq()).toBe(4);
    store.close();
  });

  it('saves PumpPortal raw events', () => {
    const store = createStore();
    const event: PumpPortalRawEvent = {
      source: 'pumpportal',
      eventType: 'new_token',
      tokenMint: 'mint-1',
      symbol: 'MPUMP',
      name: 'Mock Pump',
      signature: 'sig-1',
      raw: { txType: 'create', mint: 'mint-1' },
      receivedAt: '2026-01-01T00:00:00Z',
    };

    store.savePumpPortalEvent(event);
    const rows = store.listPumpPortalEvents(5);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: 'new_token',
      tokenMint: 'mint-1',
      symbol: 'MPUMP',
      signature: 'sig-1',
      processingStatus: 'pending',
    });

    expect(store.listPendingPumpPortalEvents(5)).toHaveLength(1);
    store.markPumpPortalEventProcessed(rows[0].id, 'processed', 'score=80');
    expect(store.listPendingPumpPortalEvents(5)).toHaveLength(0);
    expect(store.listPumpPortalEvents(5)[0]).toMatchObject({ processingStatus: 'processed', processingNote: 'score=80' });
    store.close();
  });

  it('upgrades an older database that is missing newer columns', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'solana-trade-engine-migrate-'));
    const dbPath = path.join(dir, 'legacy.sqlite');

    // Hand-build a legacy schema: pumpportal_events without processing_* /
    // processing_attempts, and scored_candidates without route_input_*. These
    // mirror what an early-version DB would look like before the columns
    // landed.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE pumpportal_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        token_mint TEXT,
        symbol TEXT,
        name TEXT,
        signature TEXT,
        raw_json TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE TABLE scored_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain TEXT NOT NULL,
        address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        name TEXT NOT NULL,
        pair_address TEXT NOT NULL,
        price_usd REAL NOT NULL,
        liquidity_usd REAL NOT NULL,
        volume_5m_usd REAL NOT NULL,
        volume_1h_usd REAL NOT NULL,
        price_change_5m_pct REAL NOT NULL,
        buys_5m INTEGER NOT NULL,
        sells_5m INTEGER NOT NULL,
        age_minutes INTEGER NOT NULL,
        source TEXT NOT NULL,
        route_available INTEGER NOT NULL,
        estimated_slippage_bps INTEGER NOT NULL,
        score INTEGER NOT NULL,
        recommendation TEXT NOT NULL,
        reasons_json TEXT NOT NULL,
        risks_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    legacy.prepare(
      `INSERT INTO pumpportal_events (event_type, token_mint, raw_json, received_at)
       VALUES ('new_token', 'mint-legacy', '{}', '2026-01-01T00:00:00Z')`,
    ).run();
    legacy.close();

    // Re-open through SqliteStore; migrate() must add the missing columns
    // without throwing, and the pre-existing row must remain queryable with
    // sensible defaults for the new columns.
    const store = new SqliteStore(dbPath);
    store.saveScoredCandidate(candidate, score);
    expect(store.listRecentScores(1)[0]).toMatchObject({
      strategyId: 'freshLaunchMomentum',
      mintAuthorityRevoked: null,
      freezeAuthorityRevoked: null,
      top5HolderPct: null,
      volumeAcceleration5mZ: null,
      volumeAccelerationSamples: null,
    });
    expect(store.listTokenVolumeSnapshots(candidate.address, 5)).toHaveLength(1);

    const rows = store.listPumpPortalEvents(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tokenMint: 'mint-legacy',
      processingStatus: 'pending',
      processingAttempts: 0,
    });

    store.markPumpPortalEventProcessed(rows[0].id, 'pending', 'first retry');
    expect(store.listPumpPortalEvents(10)[0].processingAttempts).toBe(1);
    store.close();
  });

  it('increments processing_attempts only when an event is re-deferred to pending', () => {
    const store = createStore();
    const event: PumpPortalRawEvent = {
      source: 'pumpportal',
      eventType: 'new_token',
      tokenMint: 'mint-orphan',
      raw: {},
      receivedAt: '2026-01-01T00:00:00Z',
    };
    store.savePumpPortalEvent(event);
    const [row] = store.listPumpPortalEvents(1);
    expect(row.processingAttempts).toBe(0);

    store.markPumpPortalEventProcessed(row.id, 'pending', 'no data');
    expect(store.listPumpPortalEvents(1)[0].processingAttempts).toBe(1);

    store.markPumpPortalEventProcessed(row.id, 'pending', 'no data');
    expect(store.listPumpPortalEvents(1)[0].processingAttempts).toBe(2);

    store.markPumpPortalEventProcessed(row.id, 'processed', 'final');
    expect(store.listPumpPortalEvents(1)[0].processingAttempts).toBe(2);

    store.close();
  });

  it('dedupes legacy duplicate closed_trades on migrate and builds the unique index', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'solana-trade-engine-dedup-'));
    const dbPath = path.join(dir, 'legacy.sqlite');

    // A pre-index DB could hold duplicate closes for one position_id. migrate()
    // must drop the extras (keeping the lowest id) before creating the unique
    // index, otherwise CREATE UNIQUE INDEX would throw on open.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE closed_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id TEXT NOT NULL, chain TEXT NOT NULL, address TEXT NOT NULL, symbol TEXT NOT NULL,
        token_json TEXT NOT NULL, entry_price_usd REAL NOT NULL, exit_price_usd REAL NOT NULL,
        quantity REAL NOT NULL, reason TEXT NOT NULL, pnl_usd REAL NOT NULL, pnl_pct REAL NOT NULL,
        opened_at TEXT NOT NULL, closed_at TEXT NOT NULL
      );
    `);
    const insert = legacy.prepare(
      `INSERT INTO closed_trades
        (position_id, chain, address, symbol, token_json, entry_price_usd, exit_price_usd,
         quantity, reason, pnl_usd, pnl_pct, opened_at, closed_at)
       VALUES ('paper-1','solana','t','S','{}',0.01,0.015,2500,'take_profit',@pnl,50,
               '2026-01-01T00:00:00Z','2026-01-01T00:05:00Z')`,
    );
    insert.run({ pnl: 12.5 }); // lowest id — kept
    insert.run({ pnl: 99.9 });
    insert.run({ pnl: 12.5 });
    legacy.close();

    // Opening through SqliteStore runs migrate(); it must not throw.
    const store = new SqliteStore(dbPath);
    expect(store.listClosedTrades(50)).toHaveLength(1);
    expect(store.listClosedTrades(50)[0]).toMatchObject({ exitPriceSource: 'fresh' });
    expect(store.getRealizedPnlUsd()).toBeCloseTo(12.5);

    // The unique index is now in force: a duplicate close is ignored, not added.
    store.saveClosedTrade({
      positionId: 'paper-1',
      token: candidate,
      entryPriceUsd: 0.01,
      exitPriceUsd: 0.02,
      quantity: 2500,
      openedAt: new Date('2026-01-01T00:00:00Z'),
      closedAt: new Date('2026-01-01T00:10:00Z'),
      reason: 'take_profit',
      exitPriceSource: 'fresh',
      pnlUsd: 25,
      pnlPct: 100,
    });
    expect(store.listClosedTrades(50)).toHaveLength(1);
    store.close();
  });

  it('listRetriableScoredCandidates returns fresh high-scoring untouched candidates deduplicated by address', () => {
    const store = createStore();
    const cutoff = '2026-01-01T00:00:00.000Z';

    // scored twice — only the highest score should come back
    store.saveScoredCandidate({ ...candidate, address: 'mint-a' }, { ...score, total: 80 });
    store.saveScoredCandidate({ ...candidate, address: 'mint-a' }, { ...score, total: 90 });
    // below threshold
    store.saveScoredCandidate({ ...candidate, address: 'mint-low' }, { ...score, total: 70 });
    // open position exists — should be excluded
    store.saveScoredCandidate({ ...candidate, address: 'mint-open' }, score);
    store.saveOpenPosition({ id: 'paper-x', token: { ...candidate, address: 'mint-open' }, score: 82, entryPriceUsd: 0.01, quantity: 100, openedAt: new Date('2026-01-01T00:01:00Z'), highWaterMarkUsd: 0.01 });

    const rows = store.listRetriableScoredCandidates({ minScore: 75, cutoffIso: cutoff });

    const addresses = rows.map((r) => r.address);
    expect(addresses).toContain('mint-a');
    expect(addresses).not.toContain('mint-low');
    expect(addresses).not.toContain('mint-open');
    // deduplication: mint-a appears only once
    expect(addresses.filter((a) => a === 'mint-a')).toHaveLength(1);
    // the row for mint-a has the higher score
    expect(rows.find((r) => r.address === 'mint-a')?.score).toBe(90);
    expect(rows.find((r) => r.address === 'mint-a')).toMatchObject({
      strategyId: 'freshLaunchMomentum',
      mintAuthorityRevoked: null,
      freezeAuthorityRevoked: null,
      top5HolderPct: null,
      volumeAcceleration5mZ: null,
      volumeAccelerationSamples: null,
    });
    store.close();
  });

  it('applies strategy-specific thresholds before limiting retriable scored candidates', () => {
    const store = createStore();
    const cutoff = '2026-01-01T00:00:00.000Z';

    store.saveScoredCandidate({ ...candidate, address: 'fresh-too-low', strategyId: 'freshLaunchMomentum' }, { ...score, total: 70 });
    store.saveScoredCandidate({ ...candidate, address: 'migration-ok', strategyId: 'migrationMomentum' }, { ...score, total: 70 });

    const rows = store.listRetriableScoredCandidates({
      minScore: 70,
      cutoffIso: cutoff,
      limit: 1,
      strategyMinScores: {
        freshLaunchMomentum: 75,
        migrationMomentum: 70,
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ address: 'migration-ok', strategyId: 'migrationMomentum', score: 70 });
    store.close();
  });
});
