import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { PumpPortalRawEvent } from '../discovery/pumpPortal.js';
import type { OpportunityScore, PaperPosition, PaperTrade, TokenCandidate } from '../types/domain.js';

interface RecentScoreRow {
  chain: string;
  address: string;
  symbol: string;
  name: string;
  pairAddress: string;
  priceUsd: number;
  liquidityUsd: number;
  volume5mUsd: number;
  routeInputMint?: string;
  routeInputSymbol?: string;
  score: number;
  recommendation: string;
  createdAt: string;
}

interface OpenPositionRow {
  id: string;
  chain: string;
  address: string;
  symbol: string;
  entryPriceUsd: number;
  quantity: number;
  score: number;
  openedAt: string;
}

interface ClosedTradeRow {
  positionId: string;
  chain: string;
  address: string;
  symbol: string;
  entryPriceUsd: number;
  exitPriceUsd: number;
  quantity: number;
  reason: string;
  exitPriceSource: string;
  pnlUsd: number;
  pnlPct: number;
  openedAt: string;
  closedAt: string;
}

interface PumpPortalEventRow {
  id: number;
  eventType: string;
  tokenMint?: string;
  symbol?: string;
  name?: string;
  signature?: string;
  rawJson: string;
  receivedAt: string;
  processingStatus?: string;
  processingNote?: string;
  processedAt?: string;
  processingAttempts?: number;
}

export interface ClosedTradeStatRow {
  reason: string;
  exitPriceSource: string;
  score: number;
  source: string;
  pnlUsd: number;
  pnlPct: number;
  openedAt: string;
  closedAt: string;
}

export interface TrackableScoredCandidateRow {
  id: number;
  address: string;
  scoredPriceUsd: number;
  createdAt: string;
  outcomeHighUsd: number | null;
  outcomeLowUsd: number | null;
}

export interface ScoredOutcomeUpdate {
  id: number;
  outcomeHighUsd: number;
  outcomeLowUsd: number;
  outcomeLastUsd: number;
  outcomeLastAt: string;
  done: boolean;
}

export interface ScoredOutcomeStatRow {
  score: number;
  recommendation: string;
  scoredPriceUsd: number;
  outcomeHighUsd: number;
  outcomeLowUsd: number;
  outcomeLastUsd: number;
}

export class SqliteStore {
  private readonly db: Database.Database;

  constructor(dbPath = 'data/hermes-paper-bot.sqlite') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  saveScoredCandidate(candidate: TokenCandidate, score: OpportunityScore): void {
    this.db
      .prepare(
        `INSERT INTO scored_candidates (
          chain, address, symbol, name, pair_address, price_usd, liquidity_usd, volume_5m_usd,
          volume_1h_usd, price_change_5m_pct, buys_5m, sells_5m, age_minutes, source,
          route_available, estimated_slippage_bps, route_input_mint, route_input_symbol,
          score, recommendation, reasons_json, risks_json, created_at
        ) VALUES (
          @chain, @address, @symbol, @name, @pairAddress, @priceUsd, @liquidityUsd, @volume5mUsd,
          @volume1hUsd, @priceChange5mPct, @buys5m, @sells5m, @ageMinutes, @source,
          @routeAvailable, @estimatedSlippageBps, @routeInputMint, @routeInputSymbol,
          @score, @recommendation, @reasonsJson, @risksJson, @createdAt
        )`,
      )
      .run({
        ...candidate,
        routeAvailable: candidate.routeAvailable ? 1 : 0,
        routeInputMint: candidate.routeInputMint ?? null,
        routeInputSymbol: candidate.routeInputSymbol ?? null,
        score: score.total,
        recommendation: score.recommendation,
        reasonsJson: JSON.stringify(score.reasons),
        risksJson: JSON.stringify(score.risks),
        createdAt: new Date().toISOString(),
      });
  }

  listRecentScores(limit = 20): RecentScoreRow[] {
    return this.db
      .prepare(
        `SELECT chain, address, symbol, name, pair_address as pairAddress, price_usd as priceUsd,
                liquidity_usd as liquidityUsd, volume_5m_usd as volume5mUsd,
                route_input_mint as routeInputMint, route_input_symbol as routeInputSymbol,
                score, recommendation, created_at as createdAt
         FROM scored_candidates
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit) as RecentScoreRow[];
  }

  saveOpenPosition(position: PaperPosition): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO open_positions (
          id, chain, address, symbol, token_json, score, entry_price_usd, quantity, opened_at,
          high_water_mark_usd, last_mark_usd
        ) VALUES (@id, @chain, @address, @symbol, @tokenJson, @score, @entryPriceUsd, @quantity, @openedAt,
          @highWaterMarkUsd, @lastMarkUsd)`,
      )
      .run({
        id: position.id,
        chain: position.token.chain,
        address: position.token.address,
        symbol: position.token.symbol,
        tokenJson: JSON.stringify(position.token),
        score: position.score,
        entryPriceUsd: position.entryPriceUsd,
        quantity: position.quantity,
        openedAt: position.openedAt.toISOString(),
        highWaterMarkUsd: position.highWaterMarkUsd,
        lastMarkUsd: position.lastMarkUsd ?? position.entryPriceUsd,
      });
  }

  // Full reconstruction of open positions (including the embedded token and
  // high-water mark) so the PaperBroker can be rehydrated across passes/restarts.
  loadOpenPositions(): PaperPosition[] {
    const rows = this.db
      .prepare(
        `SELECT id, token_json as tokenJson, score, entry_price_usd as entryPriceUsd,
                quantity, opened_at as openedAt, high_water_mark_usd as highWaterMarkUsd,
                last_mark_usd as lastMarkUsd
         FROM open_positions
         ORDER BY opened_at ASC`,
      )
      .all() as Array<{
      id: string;
      tokenJson: string;
      score: number;
      entryPriceUsd: number;
      quantity: number;
      openedAt: string;
      highWaterMarkUsd: number | null;
      lastMarkUsd: number | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      token: JSON.parse(row.tokenJson) as TokenCandidate,
      score: row.score,
      entryPriceUsd: row.entryPriceUsd,
      quantity: row.quantity,
      openedAt: new Date(row.openedAt),
      // Older rows predating the columns fall back to the entry price.
      highWaterMarkUsd: row.highWaterMarkUsd ?? row.entryPriceUsd,
      lastMarkUsd: row.lastMarkUsd ?? row.entryPriceUsd,
    }));
  }

  getRealizedPnlUsd(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(pnl_usd), 0) as total FROM closed_trades').get() as {
      total: number;
    };
    return row.total;
  }

  // Realized PnL booked at or after the given ISO timestamp. closed_at is stored
  // as an ISO-8601 string, so lexicographic comparison matches chronological order.
  getRealizedPnlUsdSince(sinceIso: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(pnl_usd), 0) as total FROM closed_trades WHERE closed_at >= ?')
      .get(sinceIso) as { total: number };
    return row.total;
  }

  // Next free `paper-N` sequence across both open and closed positions so a
  // rehydrated broker never reuses an id that already exists in either table.
  getNextPositionSeq(): number {
    const rows = this.db
      .prepare(
        `SELECT id FROM open_positions
         UNION ALL
         SELECT position_id as id FROM closed_trades`,
      )
      .all() as Array<{ id: string }>;
    let maxSeq = 0;
    for (const { id } of rows) {
      const match = /^paper-(\d+)$/.exec(id);
      if (match) {
        maxSeq = Math.max(maxSeq, Number(match[1]));
      }
    }
    return maxSeq + 1;
  }

  listOpenPositions(): OpenPositionRow[] {
    return this.db
      .prepare(
        `SELECT id, chain, address, symbol, entry_price_usd as entryPriceUsd,
                quantity, score, opened_at as openedAt
         FROM open_positions
         ORDER BY opened_at ASC`,
      )
      .all() as OpenPositionRow[];
  }

  saveClosedTrade(trade: PaperTrade): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO closed_trades (
        position_id, chain, address, symbol, token_json, score, source, entry_price_usd, exit_price_usd,
        quantity, reason, exit_price_source, pnl_usd, pnl_pct, opened_at, closed_at
      ) VALUES (
        @positionId, @chain, @address, @symbol, @tokenJson, @score, @source, @entryPriceUsd, @exitPriceUsd,
        @quantity, @reason, @exitPriceSource, @pnlUsd, @pnlPct, @openedAt, @closedAt
      )`,
    );
    const removeOpen = this.db.prepare('DELETE FROM open_positions WHERE id = ?');

    const transaction = this.db.transaction(() => {
      insert.run({
        positionId: trade.positionId,
        chain: trade.token.chain,
        address: trade.token.address,
        symbol: trade.token.symbol,
        tokenJson: JSON.stringify(trade.token),
        score: trade.score ?? 0,
        source: trade.token.source ?? '',
        entryPriceUsd: trade.entryPriceUsd,
        exitPriceUsd: trade.exitPriceUsd,
        quantity: trade.quantity,
        reason: trade.reason,
        exitPriceSource: trade.exitPriceSource ?? 'fresh',
        pnlUsd: trade.pnlUsd,
        pnlPct: trade.pnlPct,
        openedAt: trade.openedAt.toISOString(),
        closedAt: trade.closedAt.toISOString(),
      });
      removeOpen.run(trade.positionId);
    });
    transaction();
  }

  // All closed trades projected to the fields performance analytics needs. Not
  // limited: aggregate stats should reflect the full history, not a recent page.
  loadClosedTradeStats(): ClosedTradeStatRow[] {
    return this.db
      .prepare(
        `SELECT reason, exit_price_source as exitPriceSource, score, source,
                pnl_usd as pnlUsd, pnl_pct as pnlPct, opened_at as openedAt, closed_at as closedAt
         FROM closed_trades
         ORDER BY closed_at ASC`,
      )
      .all() as ClosedTradeStatRow[];
  }

  listClosedTrades(limit = 50): ClosedTradeRow[] {
    return this.db
      .prepare(
        `SELECT position_id as positionId, chain, address, symbol,
                entry_price_usd as entryPriceUsd, exit_price_usd as exitPriceUsd,
                quantity, reason, exit_price_source as exitPriceSource, pnl_usd as pnlUsd, pnl_pct as pnlPct,
                opened_at as openedAt, closed_at as closedAt
         FROM closed_trades
         ORDER BY closed_at DESC
         LIMIT ?`,
      )
      .all(limit) as ClosedTradeRow[];
  }

  // Scored candidates still inside their forward-tracking window that have a
  // mint and a positive scored price. Stale ones (past the window) should be
  // finalized via markStaleScoredOutcomesDone first so they are not returned.
  listTrackableScoredCandidates(limit = 200): TrackableScoredCandidateRow[] {
    return this.db
      .prepare(
        `SELECT id, address, price_usd as scoredPriceUsd, created_at as createdAt,
                outcome_high_usd as outcomeHighUsd, outcome_low_usd as outcomeLowUsd
         FROM scored_candidates
         WHERE outcome_done = 0 AND address != '' AND price_usd > 0
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit) as TrackableScoredCandidateRow[];
  }

  // Finalize candidates whose tracking window has elapsed so they stop being
  // re-checked even if they were never priced again.
  markStaleScoredOutcomesDone(cutoffIso: string): number {
    const result = this.db
      .prepare('UPDATE scored_candidates SET outcome_done = 1 WHERE outcome_done = 0 AND created_at < ?')
      .run(cutoffIso);
    return result.changes;
  }

  recordScoredOutcome(update: ScoredOutcomeUpdate): void {
    this.db
      .prepare(
        `UPDATE scored_candidates
         SET outcome_high_usd = @outcomeHighUsd,
             outcome_low_usd = @outcomeLowUsd,
             outcome_last_usd = @outcomeLastUsd,
             outcome_last_at = @outcomeLastAt,
             outcome_samples = outcome_samples + 1,
             outcome_done = @done
         WHERE id = @id`,
      )
      .run({
        id: update.id,
        outcomeHighUsd: update.outcomeHighUsd,
        outcomeLowUsd: update.outcomeLowUsd,
        outcomeLastUsd: update.outcomeLastUsd,
        outcomeLastAt: update.outcomeLastAt,
        done: update.done ? 1 : 0,
      });
  }

  // Scored candidates with at least one forward observation, projected for
  // excursion analysis (MFE/MAE vs the scored price).
  loadScoredOutcomeStats(): ScoredOutcomeStatRow[] {
    return this.db
      .prepare(
        `SELECT score, recommendation, price_usd as scoredPriceUsd,
                outcome_high_usd as outcomeHighUsd, outcome_low_usd as outcomeLowUsd,
                outcome_last_usd as outcomeLastUsd
         FROM scored_candidates
         WHERE outcome_samples > 0 AND outcome_high_usd IS NOT NULL AND price_usd > 0`,
      )
      .all() as ScoredOutcomeStatRow[];
  }

  savePumpPortalEvent(event: PumpPortalRawEvent): void {
    this.db
      .prepare(
        `INSERT INTO pumpportal_events (
          event_type, token_mint, symbol, name, signature, raw_json, received_at
        ) VALUES (
          @eventType, @tokenMint, @symbol, @name, @signature, @rawJson, @receivedAt
        )`,
      )
      .run({
        eventType: event.eventType,
        tokenMint: event.tokenMint ?? null,
        symbol: event.symbol ?? null,
        name: event.name ?? null,
        signature: event.signature ?? null,
        rawJson: JSON.stringify(event.raw),
        receivedAt: event.receivedAt,
      });
  }

  listPumpPortalEvents(limit = 50): PumpPortalEventRow[] {
    return this.db
      .prepare(
        `SELECT id, event_type as eventType, token_mint as tokenMint, symbol, name,
                signature, raw_json as rawJson, received_at as receivedAt,
                processing_status as processingStatus, processing_note as processingNote,
                processed_at as processedAt, processing_attempts as processingAttempts
         FROM pumpportal_events
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit) as PumpPortalEventRow[];
  }

  listPendingPumpPortalEvents(limit = 50): PumpPortalEventRow[] {
    return this.db
      .prepare(
        `SELECT id, event_type as eventType, token_mint as tokenMint, symbol, name,
                signature, raw_json as rawJson, received_at as receivedAt,
                processing_status as processingStatus, processing_note as processingNote,
                processed_at as processedAt, processing_attempts as processingAttempts
         FROM pumpportal_events
         WHERE processing_status = 'pending' AND token_mint IS NOT NULL AND token_mint != ''
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(limit) as PumpPortalEventRow[];
  }

  markPumpPortalEventProcessed(id: number, status: 'pending' | 'processed' | 'skipped' | 'failed', note?: string): void {
    // Bump processing_attempts whenever we defer the row back to 'pending' so
    // callers can cap retries on abandoned mints (no market data ever appears).
    this.db
      .prepare(
        `UPDATE pumpportal_events
         SET processing_status = @status,
             processing_note = @note,
             processed_at = @processedAt,
             processing_attempts = processing_attempts + CASE WHEN @status = 'pending' THEN 1 ELSE 0 END
         WHERE id = @id`,
      )
      .run({ id, status, note: note ?? null, processedAt: new Date().toISOString() });
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scored_candidates (
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
        route_input_mint TEXT,
        route_input_symbol TEXT,
        score INTEGER NOT NULL,
        recommendation TEXT NOT NULL,
        reasons_json TEXT NOT NULL,
        risks_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        outcome_high_usd REAL,
        outcome_low_usd REAL,
        outcome_last_usd REAL,
        outcome_samples INTEGER NOT NULL DEFAULT 0,
        outcome_last_at TEXT,
        outcome_done INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_scored_candidates_created_at ON scored_candidates(created_at);
      CREATE INDEX IF NOT EXISTS idx_scored_candidates_chain_score ON scored_candidates(chain, score);

      CREATE TABLE IF NOT EXISTS open_positions (
        id TEXT PRIMARY KEY,
        chain TEXT NOT NULL,
        address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        token_json TEXT NOT NULL,
        score INTEGER NOT NULL,
        entry_price_usd REAL NOT NULL,
        quantity REAL NOT NULL,
        opened_at TEXT NOT NULL,
        high_water_mark_usd REAL,
        last_mark_usd REAL
      );

      CREATE TABLE IF NOT EXISTS closed_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id TEXT NOT NULL,
        chain TEXT NOT NULL,
        address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        token_json TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT '',
        entry_price_usd REAL NOT NULL,
        exit_price_usd REAL NOT NULL,
        quantity REAL NOT NULL,
        reason TEXT NOT NULL,
        exit_price_source TEXT NOT NULL DEFAULT 'fresh',
        pnl_usd REAL NOT NULL,
        pnl_pct REAL NOT NULL,
        opened_at TEXT NOT NULL,
        closed_at TEXT NOT NULL
      );

      DELETE FROM closed_trades
      WHERE id NOT IN (
        SELECT MIN(id)
        FROM closed_trades
        GROUP BY position_id
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_closed_trades_position_id ON closed_trades(position_id);

      CREATE TABLE IF NOT EXISTS pumpportal_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        token_mint TEXT,
        symbol TEXT,
        name TEXT,
        signature TEXT,
        raw_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        processing_status TEXT NOT NULL DEFAULT 'pending',
        processing_note TEXT,
        processed_at TEXT,
        processing_attempts INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_pumpportal_events_received_at ON pumpportal_events(received_at);
      CREATE INDEX IF NOT EXISTS idx_pumpportal_events_type_mint ON pumpportal_events(event_type, token_mint);
    `);
    this.addColumnIfMissing('open_positions', 'high_water_mark_usd', 'REAL');
    this.addColumnIfMissing('open_positions', 'last_mark_usd', 'REAL');
    this.addColumnIfMissing('closed_trades', 'exit_price_source', "TEXT NOT NULL DEFAULT 'fresh'");
    this.addColumnIfMissing('closed_trades', 'score', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('closed_trades', 'source', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('scored_candidates', 'route_input_mint', 'TEXT');
    this.addColumnIfMissing('scored_candidates', 'route_input_symbol', 'TEXT');
    this.addColumnIfMissing('scored_candidates', 'outcome_high_usd', 'REAL');
    this.addColumnIfMissing('scored_candidates', 'outcome_low_usd', 'REAL');
    this.addColumnIfMissing('scored_candidates', 'outcome_last_usd', 'REAL');
    this.addColumnIfMissing('scored_candidates', 'outcome_samples', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('scored_candidates', 'outcome_last_at', 'TEXT');
    this.addColumnIfMissing('scored_candidates', 'outcome_done', 'INTEGER NOT NULL DEFAULT 0');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_scored_candidates_outcome_done ON scored_candidates(outcome_done, created_at)');
    this.addColumnIfMissing('pumpportal_events', 'processing_status', "TEXT NOT NULL DEFAULT 'pending'");
    this.addColumnIfMissing('pumpportal_events', 'processing_note', 'TEXT');
    this.addColumnIfMissing('pumpportal_events', 'processed_at', 'TEXT');
    this.addColumnIfMissing('pumpportal_events', 'processing_attempts', 'INTEGER NOT NULL DEFAULT 0');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_pumpportal_events_processing_status ON pumpportal_events(processing_status, id)');
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((existing) => existing.name === column)) {
      this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
    }
  }
}
