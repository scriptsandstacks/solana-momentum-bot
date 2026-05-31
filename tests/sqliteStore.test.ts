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
  const dir = mkdtempSync(path.join(tmpdir(), 'hermes-paper-bot-'));
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
      pnlUsd: 12.5,
      pnlPct: 50,
    };

    store.saveOpenPosition(position);
    expect(store.listOpenPositions()).toHaveLength(1);

    store.saveClosedTrade(trade);
    expect(store.listOpenPositions()).toHaveLength(0);
    expect(store.listClosedTrades()).toHaveLength(1);
    expect(store.listClosedTrades()[0]).toMatchObject({ positionId: 'paper-1', pnlUsd: 12.5 });
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
    const dir = mkdtempSync(path.join(tmpdir(), 'hermes-paper-bot-migrate-'));
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
});
