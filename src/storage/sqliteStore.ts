import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { PumpPortalRawEvent } from '../discovery/pumpPortal.js';
import { FRESH_LAUNCH_MOMENTUM_STRATEGY_ID } from '../strategies/freshLaunchMomentum.js';
import type { OpportunityScore, PaperPosition, PaperTrade, TokenCandidate } from '../types/domain.js';
import type { LiveExecutionJournalEntry } from '../execution/liveExecutionJournal.js';

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
  strategyId: string;
  sellRouteAvailable: number | null;
  mintAuthorityRevoked: number | null;
  freezeAuthorityRevoked: number | null;
  top5HolderPct: number | null;
  volumeAcceleration5mZ: number | null;
  volumeAccelerationSamples: number | null;
  score: number;
  recommendation: string;
  createdAt: string;
}

interface OpenPositionRow {
  id: string;
  chain: string;
  address: string;
  symbol: string;
  strategyId: string;
  entryPriceUsd: number;
  quantity: number;
  score: number;
  openedAt: string;
  entryTxSignature?: string;
  entryNetworkFeeUsd?: number;
  entryNetworkFeeLamports?: number;
}

interface ClosedTradeRow {
  positionId: string;
  chain: string;
  address: string;
  symbol: string;
  strategyId: string;
  entryPriceUsd: number;
  exitPriceUsd: number;
  quantity: number;
  reason: string;
  exitPriceSource: string;
  pnlUsd: number;
  pnlPct: number;
  openedAt: string;
  closedAt: string;
  exitTxSignature?: string;
  entryNetworkFeeUsd?: number;
  exitNetworkFeeUsd?: number;
  entryNetworkFeeLamports?: number;
  exitNetworkFeeLamports?: number;
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

export interface BotRuntimeStatusUpdate {
  status: 'running' | 'stopping' | 'stopped';
  lastLoopAt?: string;
  lastIngestAt?: string;
  lastProcessPassAt?: string;
  lastExitPassAt?: string;
  lastError?: string | null;
}

export interface BotRuntimeStatusRow {
  id: string;
  status: string;
  lastLoopAt?: string;
  lastIngestAt?: string;
  lastProcessPassAt?: string;
  lastExitPassAt?: string;
  latestRawEventAt?: string;
  latestProcessedEventAt?: string;
  latestScoredCandidateAt?: string;
  latestTradeAt?: string;
  pendingEventCount: number;
  openPositionCount: number;
  lastError?: string;
  updatedAt: string;
}

export interface ClosedTradeStatRow {
  reason: string;
  exitPriceSource: string;
  score: number;
  source: string;
  strategyId: string;
  pnlUsd: number;
  pnlPct: number;
  openedAt: string;
  closedAt: string;
  entryPriceUsd: number;
  exitPriceUsd: number;
  quantity: number;
  entryNetworkFeeUsd: number | null;
  exitNetworkFeeUsd: number | null;
}

export interface TrackableScoredCandidateRow {
  id: number;
  address: string;
  scoredPriceUsd: number;
  createdAt: string;
  outcomeHighUsd: number | null;
  outcomeLowUsd: number | null;
  outcomeFirstTakeProfitAt: string | null;
  outcomeFirstStopLossAt: string | null;
}

export interface ScoredOutcomeUpdate {
  id: number;
  outcomeHighUsd: number;
  outcomeLowUsd: number;
  outcomeLastUsd: number;
  outcomeLastAt: string;
  outcomeFirstTakeProfitAt: string | null;
  outcomeFirstStopLossAt: string | null;
  done: boolean;
}

export interface ScoredOutcomeStatRow {
  strategyId: string;
  score: number;
  recommendation: string;
  scoredPriceUsd: number;
  outcomeHighUsd: number;
  outcomeLowUsd: number;
  outcomeLastUsd: number;
  outcomeFirstTakeProfitAt: string | null;
  outcomeFirstStopLossAt: string | null;
  mintAuthorityRevoked: number | null;
  freezeAuthorityRevoked: number | null;
  top5HolderPct: number | null;
  volumeAcceleration5mZ: number | null;
}

// A recently scored candidate that was never opened into a position. Used by the
// retry pass to fill broker capacity that opened up after an exit.
export interface RetriableScoredCandidateRow {
  chain: string;
  address: string;
  symbol: string;
  name: string;
  pairAddress: string;
  priceUsd: number;
  liquidityUsd: number;
  volume5mUsd: number;
  volume1hUsd: number;
  priceChange5mPct: number;
  buys5m: number;
  sells5m: number;
  ageMinutes: number;
  source: string;
  routeAvailable: number;
  estimatedSlippageBps: number;
  routeInputMint: string | null;
  routeInputSymbol: string | null;
  strategyId: string;
  sellRouteAvailable: number | null;
  mintAuthorityRevoked: number | null;
  freezeAuthorityRevoked: number | null;
  top5HolderPct: number | null;
  volumeAcceleration5mZ: number | null;
  volumeAccelerationSamples: number | null;
  score: number;
}

export interface TokenVolumeSnapshotRow {
  chain: string;
  address: string;
  symbol: string;
  strategyId: string;
  volume5mUsd: number;
  volume1hUsd: number;
  priceUsd: number;
  observedAt: string;
}

export class SqliteStore {
  private readonly db: Database.Database;

  constructor(dbPath = 'data/solana-trade-engine.sqlite') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  saveScoredCandidate(candidate: TokenCandidate, score: OpportunityScore): void {
    const strategyId = candidate.strategyId ?? FRESH_LAUNCH_MOMENTUM_STRATEGY_ID;
    const insertScore = this.db.prepare(
      `INSERT INTO scored_candidates (
        chain, address, symbol, name, pair_address, price_usd, liquidity_usd, volume_5m_usd,
        volume_1h_usd, price_change_5m_pct, buys_5m, sells_5m, age_minutes, source,
        route_available, estimated_slippage_bps, route_input_mint, route_input_symbol,
        strategy_id, sell_route_available,
        mint_authority_revoked, freeze_authority_revoked, top5_holder_pct,
        volume_acceleration_5m_z, volume_acceleration_samples,
        score, recommendation, reasons_json, risks_json, created_at
      ) VALUES (
        @chain, @address, @symbol, @name, @pairAddress, @priceUsd, @liquidityUsd, @volume5mUsd,
        @volume1hUsd, @priceChange5mPct, @buys5m, @sells5m, @ageMinutes, @source,
        @routeAvailable, @estimatedSlippageBps, @routeInputMint, @routeInputSymbol,
        @strategyId, @sellRouteAvailable,
        @mintAuthorityRevoked, @freezeAuthorityRevoked, @top5HolderPct,
        @volumeAcceleration5mZ, @volumeAccelerationSamples,
        @score, @recommendation, @reasonsJson, @risksJson, @createdAt
      )`,
    );
    const insertVolume = this.db.prepare(
      `INSERT INTO token_volume_snapshots (
        chain, address, symbol, strategy_id, volume_5m_usd, volume_1h_usd, price_usd, observed_at
      ) VALUES (
        @chain, @address, @symbol, @strategyId, @volume5mUsd, @volume1hUsd, @priceUsd, @observedAt
      )`,
    );
    const createdAt = new Date().toISOString();
    const payload = {
      ...candidate,
      routeAvailable: candidate.routeAvailable ? 1 : 0,
      routeInputMint: candidate.routeInputMint ?? null,
      routeInputSymbol: candidate.routeInputSymbol ?? null,
      strategyId,
      sellRouteAvailable: candidate.sellRouteAvailable === undefined ? null : candidate.sellRouteAvailable ? 1 : 0,
      mintAuthorityRevoked: candidate.mintAuthorityRevoked === undefined ? null : candidate.mintAuthorityRevoked ? 1 : 0,
      freezeAuthorityRevoked: candidate.freezeAuthorityRevoked === undefined ? null : candidate.freezeAuthorityRevoked ? 1 : 0,
      top5HolderPct: candidate.top5HolderPct ?? null,
      volumeAcceleration5mZ: candidate.volumeAcceleration5mZ ?? null,
      volumeAccelerationSamples: candidate.volumeAccelerationSamples ?? null,
      score: score.total,
      recommendation: score.recommendation,
      reasonsJson: JSON.stringify(score.reasons),
      risksJson: JSON.stringify(score.risks),
      createdAt,
      observedAt: createdAt,
    };

    const transaction = this.db.transaction(() => {
      insertScore.run(payload);
      insertVolume.run(payload);
    });
    transaction();
  }

  listRecentScores(limit = 20): RecentScoreRow[] {
    return this.db
      .prepare(
        `SELECT chain, address, symbol, name, pair_address as pairAddress, price_usd as priceUsd,
                liquidity_usd as liquidityUsd, volume_5m_usd as volume5mUsd,
                route_input_mint as routeInputMint, route_input_symbol as routeInputSymbol,
                strategy_id as strategyId, sell_route_available as sellRouteAvailable,
                mint_authority_revoked as mintAuthorityRevoked, freeze_authority_revoked as freezeAuthorityRevoked,
                top5_holder_pct as top5HolderPct,
                volume_acceleration_5m_z as volumeAcceleration5mZ,
                volume_acceleration_samples as volumeAccelerationSamples,
                score, recommendation, created_at as createdAt
         FROM scored_candidates
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit) as RecentScoreRow[];
  }

  listRetriableScoredCandidates(options: {
    minScore: number;
    cutoffIso: string;
    limit?: number;
    strategyMinScores?: Record<string, number>;
  }): RetriableScoredCandidateRow[] {
    // Return the best-scored (most recent tie-break) row per address for candidates
    // that (a) scored high enough, (b) are still within the trade horizon, (c) have
    // no open position, and (d) have no position that was opened after the cutoff.
    // ROW_NUMBER deduplicates addresses so a token scored multiple times is only
    // offered once (highest score wins).
    const strategyEntries = Object.entries(options.strategyMinScores ?? {});
    const strategyThresholdCases = strategyEntries
      .map((_, index) => `WHEN @strategyId${index} THEN @strategyMinScore${index}`)
      .join(' ');
    const minScoreExpression = strategyEntries.length > 0 ? `CASE strategy_id ${strategyThresholdCases} ELSE @minScore END` : '@minScore';
    const params: Record<string, string | number> = {
      minScore: options.minScore,
      cutoffIso: options.cutoffIso,
      limit: options.limit ?? 10,
    };
    for (const [index, [strategyId, minScore]] of strategyEntries.entries()) {
      params[`strategyId${index}`] = strategyId;
      params[`strategyMinScore${index}`] = minScore;
    }

    return this.db
      .prepare(
        `WITH ranked AS (
           SELECT chain, address, symbol, name, pair_address as pairAddress,
                  price_usd as priceUsd, liquidity_usd as liquidityUsd,
                  volume_5m_usd as volume5mUsd, volume_1h_usd as volume1hUsd,
                  price_change_5m_pct as priceChange5mPct, buys_5m as buys5m, sells_5m as sells5m,
                  age_minutes as ageMinutes, source,
                  route_available as routeAvailable, estimated_slippage_bps as estimatedSlippageBps,
                  route_input_mint as routeInputMint, route_input_symbol as routeInputSymbol,
                  strategy_id as strategyId, sell_route_available as sellRouteAvailable,
                  mint_authority_revoked as mintAuthorityRevoked, freeze_authority_revoked as freezeAuthorityRevoked,
                  top5_holder_pct as top5HolderPct,
                  volume_acceleration_5m_z as volumeAcceleration5mZ,
                  volume_acceleration_samples as volumeAccelerationSamples,
                  score,
                  ROW_NUMBER() OVER (PARTITION BY address ORDER BY score DESC, id DESC) as rn
           FROM scored_candidates
           WHERE score >= ${minScoreExpression}
             AND recommendation = 'paper_trade'
             AND created_at >= @cutoffIso
             AND address NOT IN (SELECT address FROM open_positions)
             AND address NOT IN (
               SELECT address FROM closed_trades WHERE opened_at >= @cutoffIso
             )
         )
         SELECT chain, address, symbol, name, pairAddress,
                priceUsd, liquidityUsd, volume5mUsd, volume1hUsd,
                priceChange5mPct, buys5m, sells5m, ageMinutes, source,
                routeAvailable, estimatedSlippageBps, routeInputMint, routeInputSymbol,
                strategyId, sellRouteAvailable, mintAuthorityRevoked, freezeAuthorityRevoked, top5HolderPct,
                volumeAcceleration5mZ, volumeAccelerationSamples, score
         FROM ranked WHERE rn = 1
         ORDER BY score DESC
         LIMIT @limit`,
      )
      .all(params) as RetriableScoredCandidateRow[];
  }

  listTokenVolumeSnapshots(address: string, limit = 50): TokenVolumeSnapshotRow[] {
    return this.db
      .prepare(
        `SELECT chain, address, symbol, strategy_id as strategyId,
                volume_5m_usd as volume5mUsd, volume_1h_usd as volume1hUsd,
                price_usd as priceUsd, observed_at as observedAt
         FROM token_volume_snapshots
         WHERE address = ?
         ORDER BY observed_at DESC, id DESC
         LIMIT ?`,
      )
      .all(address, limit) as TokenVolumeSnapshotRow[];
  }

  listRecentTokenVolumeSnapshots(options: { address: string; sinceIso: string; limit?: number }): TokenVolumeSnapshotRow[] {
    return this.db
      .prepare(
        `SELECT chain, address, symbol, strategy_id as strategyId,
                volume_5m_usd as volume5mUsd, volume_1h_usd as volume1hUsd,
                price_usd as priceUsd, observed_at as observedAt
         FROM token_volume_snapshots
         WHERE address = ? AND observed_at >= ?
         ORDER BY observed_at DESC, id DESC
         LIMIT ?`,
      )
      .all(options.address, options.sinceIso, options.limit ?? 50) as TokenVolumeSnapshotRow[];
  }

  saveOpenPosition(position: PaperPosition): void {
    const insert = this.db.prepare(
        `INSERT OR REPLACE INTO open_positions (
          id, chain, address, symbol, strategy_id, token_json, score, entry_price_usd, quantity, opened_at,
          high_water_mark_usd, last_mark_usd, entry_tx_signature, entry_network_fee_usd, entry_network_fee_lamports
        ) VALUES (@id, @chain, @address, @symbol, @strategyId, @tokenJson, @score, @entryPriceUsd, @quantity, @openedAt,
          @highWaterMarkUsd, @lastMarkUsd, @entryTxSignature, @entryNetworkFeeUsd, @entryNetworkFeeLamports)`,
      );
    const markPersisted = this.db.prepare(
      `UPDATE live_execution_journal
       SET status = 'persisted', updated_at = @updatedAt
       WHERE signature = @signature AND side = 'open'`,
    );
    const transaction = this.db.transaction(() => {
      insert.run({
        id: position.id,
        chain: position.token.chain,
        address: position.token.address,
        symbol: position.token.symbol,
        strategyId: position.token.strategyId ?? FRESH_LAUNCH_MOMENTUM_STRATEGY_ID,
        tokenJson: JSON.stringify({
          ...position.token,
          strategyId: position.token.strategyId ?? FRESH_LAUNCH_MOMENTUM_STRATEGY_ID,
        }),
        score: position.score,
        entryPriceUsd: position.entryPriceUsd,
        quantity: position.quantity,
        openedAt: position.openedAt.toISOString(),
        highWaterMarkUsd: position.highWaterMarkUsd,
        lastMarkUsd: position.lastMarkUsd ?? position.entryPriceUsd,
        entryTxSignature: position.entryTxSignature ?? null,
        entryNetworkFeeUsd: position.entryNetworkFeeUsd ?? null,
        entryNetworkFeeLamports: position.entryNetworkFeeLamports ?? null,
      });
      if (position.entryTxSignature) {
        markPersisted.run({ signature: position.entryTxSignature, updatedAt: new Date().toISOString() });
      }
    });
    transaction();
  }

  // Full reconstruction of open positions (including the embedded token and
  // high-water mark) so the PaperBroker can be rehydrated across passes/restarts.
  loadOpenPositions(): PaperPosition[] {
    const rows = this.db
      .prepare(
        `SELECT id, token_json as tokenJson, strategy_id as strategyId, score, entry_price_usd as entryPriceUsd,
                quantity, opened_at as openedAt, high_water_mark_usd as highWaterMarkUsd,
                last_mark_usd as lastMarkUsd, entry_tx_signature as entryTxSignature,
                entry_network_fee_usd as entryNetworkFeeUsd, entry_network_fee_lamports as entryNetworkFeeLamports
         FROM open_positions
         ORDER BY opened_at ASC`,
      )
      .all() as Array<{
      id: string;
      tokenJson: string;
      strategyId: string;
      score: number;
      entryPriceUsd: number;
      quantity: number;
      openedAt: string;
      highWaterMarkUsd: number | null;
      lastMarkUsd: number | null;
      entryTxSignature: string | null;
      entryNetworkFeeUsd: number | null;
      entryNetworkFeeLamports: number | null;
    }>;

    return rows.map((row) => {
      const token = JSON.parse(row.tokenJson) as TokenCandidate;
      token.strategyId = token.strategyId ?? row.strategyId ?? FRESH_LAUNCH_MOMENTUM_STRATEGY_ID;
      return {
        id: row.id,
        token,
        score: row.score,
        entryPriceUsd: row.entryPriceUsd,
        quantity: row.quantity,
        openedAt: new Date(row.openedAt),
        // Older rows predating the columns fall back to the entry price.
        highWaterMarkUsd: row.highWaterMarkUsd ?? row.entryPriceUsd,
        lastMarkUsd: row.lastMarkUsd ?? row.entryPriceUsd,
        entryTxSignature: row.entryTxSignature ?? undefined,
        entryNetworkFeeUsd: row.entryNetworkFeeUsd ?? undefined,
        entryNetworkFeeLamports: row.entryNetworkFeeLamports ?? undefined,
      };
    });
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
      const match = /^(?:paper|live)-(\d+)$/.exec(id);
      if (match) {
        maxSeq = Math.max(maxSeq, Number(match[1]));
      }
    }
    return maxSeq + 1;
  }

  listOpenPositions(): OpenPositionRow[] {
    return this.db
      .prepare(
        `SELECT id, chain, address, symbol, strategy_id as strategyId, entry_price_usd as entryPriceUsd,
                quantity, score, opened_at as openedAt, entry_tx_signature as entryTxSignature,
                entry_network_fee_usd as entryNetworkFeeUsd, entry_network_fee_lamports as entryNetworkFeeLamports
         FROM open_positions
         ORDER BY opened_at ASC`,
      )
      .all() as OpenPositionRow[];
  }

  saveClosedTrade(trade: PaperTrade): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO closed_trades (
        position_id, chain, address, symbol, strategy_id, token_json, score, source, entry_price_usd, exit_price_usd,
        quantity, reason, exit_price_source, pnl_usd, pnl_pct, opened_at, closed_at, exit_tx_signature
        , entry_network_fee_usd, exit_network_fee_usd, entry_network_fee_lamports, exit_network_fee_lamports
      ) VALUES (
        @positionId, @chain, @address, @symbol, @strategyId, @tokenJson, @score, @source, @entryPriceUsd, @exitPriceUsd,
        @quantity, @reason, @exitPriceSource, @pnlUsd, @pnlPct, @openedAt, @closedAt, @exitTxSignature,
        @entryNetworkFeeUsd, @exitNetworkFeeUsd, @entryNetworkFeeLamports, @exitNetworkFeeLamports
      )`,
    );
    const removeOpen = this.db.prepare('DELETE FROM open_positions WHERE id = ?');
    const markPersisted = this.db.prepare(
      `UPDATE live_execution_journal
       SET status = 'persisted', updated_at = @updatedAt
       WHERE signature = @signature AND side = 'close'`,
    );

    const transaction = this.db.transaction(() => {
      insert.run({
        positionId: trade.positionId,
        chain: trade.token.chain,
        address: trade.token.address,
        symbol: trade.token.symbol,
        strategyId: trade.token.strategyId ?? FRESH_LAUNCH_MOMENTUM_STRATEGY_ID,
        tokenJson: JSON.stringify({ ...trade.token, strategyId: trade.token.strategyId ?? FRESH_LAUNCH_MOMENTUM_STRATEGY_ID }),
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
        exitTxSignature: trade.exitTxSignature ?? null,
        entryNetworkFeeUsd: trade.entryNetworkFeeUsd ?? null,
        exitNetworkFeeUsd: trade.exitNetworkFeeUsd ?? null,
        entryNetworkFeeLamports: trade.entryNetworkFeeLamports ?? null,
        exitNetworkFeeLamports: trade.exitNetworkFeeLamports ?? null,
      });
      removeOpen.run(trade.positionId);
      if (trade.exitTxSignature) {
        markPersisted.run({ signature: trade.exitTxSignature, updatedAt: new Date().toISOString() });
      }
    });
    transaction();
  }

  recordBotRuntimeStatus(update: BotRuntimeStatusUpdate): void {
    const now = new Date().toISOString();
    const stats = this.db
      .prepare(
        `SELECT
           (SELECT MAX(received_at) FROM pumpportal_events) as latestRawEventAt,
           (SELECT MAX(processed_at) FROM pumpportal_events WHERE processed_at IS NOT NULL) as latestProcessedEventAt,
           (SELECT MAX(created_at) FROM scored_candidates) as latestScoredCandidateAt,
           (SELECT MAX(closed_at) FROM closed_trades) as latestTradeAt,
           (SELECT COUNT(*) FROM pumpportal_events WHERE processing_status = 'pending') as pendingEventCount,
           (SELECT COUNT(*) FROM open_positions) as openPositionCount`,
      )
      .get() as {
        latestRawEventAt: string | null;
        latestProcessedEventAt: string | null;
        latestScoredCandidateAt: string | null;
        latestTradeAt: string | null;
        pendingEventCount: number;
        openPositionCount: number;
      };

    this.db
      .prepare(
        `INSERT INTO bot_runtime_status (
           id, status, last_loop_at, last_ingest_at, last_process_pass_at, last_exit_pass_at,
           latest_raw_event_at, latest_processed_event_at, latest_scored_candidate_at, latest_trade_at,
           pending_event_count, open_position_count, last_error, updated_at
         ) VALUES (
           'main', @status, @lastLoopAt, @lastIngestAt, @lastProcessPassAt, @lastExitPassAt,
           @latestRawEventAt, @latestProcessedEventAt, @latestScoredCandidateAt, @latestTradeAt,
           @pendingEventCount, @openPositionCount, @lastError, @updatedAt
         )
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           last_loop_at = COALESCE(excluded.last_loop_at, bot_runtime_status.last_loop_at),
           last_ingest_at = COALESCE(excluded.last_ingest_at, bot_runtime_status.last_ingest_at),
           last_process_pass_at = COALESCE(excluded.last_process_pass_at, bot_runtime_status.last_process_pass_at),
           last_exit_pass_at = COALESCE(excluded.last_exit_pass_at, bot_runtime_status.last_exit_pass_at),
           latest_raw_event_at = excluded.latest_raw_event_at,
           latest_processed_event_at = excluded.latest_processed_event_at,
           latest_scored_candidate_at = excluded.latest_scored_candidate_at,
           latest_trade_at = excluded.latest_trade_at,
           pending_event_count = excluded.pending_event_count,
           open_position_count = excluded.open_position_count,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`,
      )
      .run({
        status: update.status,
        lastLoopAt: update.lastLoopAt ?? null,
        lastIngestAt: update.lastIngestAt ?? null,
        lastProcessPassAt: update.lastProcessPassAt ?? null,
        lastExitPassAt: update.lastExitPassAt ?? null,
        latestRawEventAt: stats.latestRawEventAt,
        latestProcessedEventAt: stats.latestProcessedEventAt,
        latestScoredCandidateAt: stats.latestScoredCandidateAt,
        latestTradeAt: stats.latestTradeAt,
        pendingEventCount: stats.pendingEventCount,
        openPositionCount: stats.openPositionCount,
        lastError: update.lastError ?? null,
        updatedAt: now,
      });
  }

  loadBotRuntimeStatus(): BotRuntimeStatusRow | undefined {
    return this.db
      .prepare(
        `SELECT id, status,
                last_loop_at as lastLoopAt,
                last_ingest_at as lastIngestAt,
                last_process_pass_at as lastProcessPassAt,
                last_exit_pass_at as lastExitPassAt,
                latest_raw_event_at as latestRawEventAt,
                latest_processed_event_at as latestProcessedEventAt,
                latest_scored_candidate_at as latestScoredCandidateAt,
                latest_trade_at as latestTradeAt,
                pending_event_count as pendingEventCount,
                open_position_count as openPositionCount,
                last_error as lastError,
                updated_at as updatedAt
         FROM bot_runtime_status
         WHERE id = 'main'`,
      )
      .get() as BotRuntimeStatusRow | undefined;
  }

  recordLiveExecutionPrepared(
    entry: Omit<LiveExecutionJournalEntry, 'signature' | 'status' | 'error' | 'createdAt' | 'updatedAt'>,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO live_execution_journal (
          id, side, position_id, mint, symbol, input_mint, output_mint,
          input_amount_base_units, status, created_at, updated_at
        ) VALUES (
          @id, @side, @positionId, @mint, @symbol, @inputMint, @outputMint,
          @inputAmountBaseUnits, 'prepared', @createdAt, @updatedAt
        )`,
      )
      .run({ ...entry, createdAt: now, updatedAt: now });
  }

  recordLiveExecutionSubmitted(id: string, signature: string, lastValidBlockHeight?: number): void {
    this.updateLiveExecutionJournal(id, 'submitted', { signature, lastValidBlockHeight });
  }

  recordLiveExecutionConfirmed(id: string): void {
    this.updateLiveExecutionJournal(id, 'confirmed');
  }

  recordLiveExecutionFailed(id: string, error: string): void {
    this.updateLiveExecutionJournal(id, 'failed', { error });
  }

  listIncompleteLiveExecutions(): LiveExecutionJournalEntry[] {
    return this.db
      .prepare(
        `SELECT id, side, position_id as positionId, mint, symbol,
                input_mint as inputMint, output_mint as outputMint,
                input_amount_base_units as inputAmountBaseUnits,
                signature, last_valid_block_height as lastValidBlockHeight,
                status, error, created_at as createdAt, updated_at as updatedAt
         FROM live_execution_journal
         WHERE status IN ('submitted', 'confirmed')
         ORDER BY created_at ASC`,
      )
      .all() as LiveExecutionJournalEntry[];
  }

  getLiveExecutionJournalEntry(id: string): LiveExecutionJournalEntry | undefined {
    return this.db
      .prepare(
        `SELECT id, side, position_id as positionId, mint, symbol,
                input_mint as inputMint, output_mint as outputMint,
                input_amount_base_units as inputAmountBaseUnits,
                signature, last_valid_block_height as lastValidBlockHeight,
                status, error, created_at as createdAt, updated_at as updatedAt
         FROM live_execution_journal
         WHERE id = ?`,
      )
      .get(id) as LiveExecutionJournalEntry | undefined;
  }

  // All closed trades projected to the fields performance analytics needs. Not
  // limited: aggregate stats should reflect the full history, not a recent page.
  loadClosedTradeStats(): ClosedTradeStatRow[] {
    return this.db
      .prepare(
        `SELECT reason, exit_price_source as exitPriceSource, score, source, strategy_id as strategyId,
                pnl_usd as pnlUsd, pnl_pct as pnlPct, opened_at as openedAt, closed_at as closedAt,
                entry_price_usd as entryPriceUsd, exit_price_usd as exitPriceUsd, quantity,
                entry_network_fee_usd as entryNetworkFeeUsd, exit_network_fee_usd as exitNetworkFeeUsd
         FROM closed_trades
         ORDER BY closed_at ASC`,
      )
      .all() as ClosedTradeStatRow[];
  }

  listClosedTrades(limit = 50): ClosedTradeRow[] {
    return this.db
      .prepare(
        `SELECT position_id as positionId, chain, address, symbol, strategy_id as strategyId,
                entry_price_usd as entryPriceUsd, exit_price_usd as exitPriceUsd,
                quantity, reason, exit_price_source as exitPriceSource, pnl_usd as pnlUsd, pnl_pct as pnlPct,
                opened_at as openedAt, closed_at as closedAt, exit_tx_signature as exitTxSignature,
                entry_network_fee_usd as entryNetworkFeeUsd, exit_network_fee_usd as exitNetworkFeeUsd,
                entry_network_fee_lamports as entryNetworkFeeLamports, exit_network_fee_lamports as exitNetworkFeeLamports
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
                outcome_high_usd as outcomeHighUsd, outcome_low_usd as outcomeLowUsd,
                outcome_first_tp_at as outcomeFirstTakeProfitAt, outcome_first_sl_at as outcomeFirstStopLossAt
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
             outcome_first_tp_at = @outcomeFirstTakeProfitAt,
             outcome_first_sl_at = @outcomeFirstStopLossAt,
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
        outcomeFirstTakeProfitAt: update.outcomeFirstTakeProfitAt,
        outcomeFirstStopLossAt: update.outcomeFirstStopLossAt,
        done: update.done ? 1 : 0,
      });
  }

  // Scored candidates with at least one forward observation, projected for
  // excursion analysis (MFE/MAE vs the scored price).
  loadScoredOutcomeStats(): ScoredOutcomeStatRow[] {
    return this.db
      .prepare(
        `SELECT strategy_id as strategyId, score, recommendation, price_usd as scoredPriceUsd,
                outcome_high_usd as outcomeHighUsd, outcome_low_usd as outcomeLowUsd,
                outcome_last_usd as outcomeLastUsd,
                outcome_first_tp_at as outcomeFirstTakeProfitAt, outcome_first_sl_at as outcomeFirstStopLossAt,
                mint_authority_revoked as mintAuthorityRevoked,
                freeze_authority_revoked as freezeAuthorityRevoked,
                top5_holder_pct as top5HolderPct,
                volume_acceleration_5m_z as volumeAcceleration5mZ
         FROM scored_candidates
         WHERE outcome_samples > 0 AND outcome_high_usd IS NOT NULL AND price_usd > 0`,
      )
      .all() as ScoredOutcomeStatRow[];
  }

  // Scored candidates older than the cutoff that never led to a position: the
  // "checked but not executed" noise. Trades are preserved by excluding any mint
  // that appears in open_positions or closed_trades, so analytics/outcome joins
  // for traded mints stay intact.
  private static readonly PRUNABLE_SCORED_WHERE = `
    created_at < @cutoff
    AND address NOT IN (SELECT address FROM open_positions WHERE address != '')
    AND address NOT IN (SELECT address FROM closed_trades WHERE address != '')
  `;

  countPrunableScoredCandidates(cutoffIso: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM scored_candidates WHERE ${SqliteStore.PRUNABLE_SCORED_WHERE}`)
      .get({ cutoff: cutoffIso }) as { n: number };
    return row.n;
  }

  pruneScoredCandidates(cutoffIso: string): number {
    const result = this.db
      .prepare(`DELETE FROM scored_candidates WHERE ${SqliteStore.PRUNABLE_SCORED_WHERE}`)
      .run({ cutoff: cutoffIso });
    return result.changes;
  }

  // Delete token volume snapshots older than cutoff. Only snapshots used for
  // volume acceleration z-score need to be kept (30-minute window). Anything
  // beyond the scored-candidate retention window is pure waste.
  pruneTokenVolumeSnapshots(cutoffIso: string): number {
    const result = this.db
      .prepare(`DELETE FROM token_volume_snapshots WHERE observed_at < ?`)
      .run(cutoffIso);
    return result.changes;
  }

  // Delete processed PumpPortal events older than cutoff. Raw events are only
  // needed until they are scored and persisted as scored_candidates. Keeping
  // them longer than a few days wastes significant disk on large raw_json blobs.
  prunePumpPortalEvents(cutoffIso: string): number {
    const result = this.db
      .prepare(`DELETE FROM pumpportal_events WHERE received_at < ? AND processing_status != 'pending'`)
      .run(cutoffIso);
    return result.changes;
  }

  // Reclaim disk after large deletes. SQLite does not shrink the file or release
  // freed pages without VACUUM. Cannot run inside a transaction.
  vacuum(): void {
    this.db.exec('VACUUM');
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
        strategy_id TEXT NOT NULL DEFAULT 'freshLaunchMomentum',
        sell_route_available INTEGER,
        mint_authority_revoked INTEGER,
        freeze_authority_revoked INTEGER,
        top5_holder_pct REAL,
        volume_acceleration_5m_z REAL,
        volume_acceleration_samples INTEGER,
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
        outcome_first_tp_at TEXT,
        outcome_first_sl_at TEXT,
        outcome_done INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_scored_candidates_created_at ON scored_candidates(created_at);
      CREATE INDEX IF NOT EXISTS idx_scored_candidates_chain_score ON scored_candidates(chain, score);

      CREATE TABLE IF NOT EXISTS token_volume_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain TEXT NOT NULL,
        address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        strategy_id TEXT NOT NULL DEFAULT 'freshLaunchMomentum',
        volume_5m_usd REAL NOT NULL,
        volume_1h_usd REAL NOT NULL,
        price_usd REAL NOT NULL,
        observed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_token_volume_snapshots_address_time ON token_volume_snapshots(address, observed_at);

      CREATE TABLE IF NOT EXISTS open_positions (
        id TEXT PRIMARY KEY,
        chain TEXT NOT NULL,
        address TEXT NOT NULL,
        symbol TEXT NOT NULL,
        strategy_id TEXT NOT NULL DEFAULT 'freshLaunchMomentum',
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
        strategy_id TEXT NOT NULL DEFAULT 'freshLaunchMomentum',
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

      CREATE TABLE IF NOT EXISTS live_execution_journal (
        id TEXT PRIMARY KEY,
        side TEXT NOT NULL,
        position_id TEXT NOT NULL,
        mint TEXT NOT NULL,
        symbol TEXT NOT NULL,
        input_mint TEXT NOT NULL,
        output_mint TEXT NOT NULL,
        input_amount_base_units TEXT NOT NULL,
        signature TEXT,
        last_valid_block_height INTEGER,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_live_execution_journal_status ON live_execution_journal(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_live_execution_journal_signature ON live_execution_journal(signature);

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

      CREATE TABLE IF NOT EXISTS bot_runtime_status (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        last_loop_at TEXT,
        last_ingest_at TEXT,
        last_process_pass_at TEXT,
        last_exit_pass_at TEXT,
        latest_raw_event_at TEXT,
        latest_processed_event_at TEXT,
        latest_scored_candidate_at TEXT,
        latest_trade_at TEXT,
        pending_event_count INTEGER NOT NULL DEFAULT 0,
        open_position_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    this.addColumnIfMissing('open_positions', 'strategy_id', "TEXT NOT NULL DEFAULT 'freshLaunchMomentum'");
    this.addColumnIfMissing('open_positions', 'high_water_mark_usd', 'REAL');
    this.addColumnIfMissing('open_positions', 'last_mark_usd', 'REAL');
    this.addColumnIfMissing('open_positions', 'entry_tx_signature', 'TEXT');
    this.addColumnIfMissing('open_positions', 'entry_network_fee_usd', 'REAL');
    this.addColumnIfMissing('open_positions', 'entry_network_fee_lamports', 'INTEGER');
    this.addColumnIfMissing('closed_trades', 'strategy_id', "TEXT NOT NULL DEFAULT 'freshLaunchMomentum'");
    this.addColumnIfMissing('closed_trades', 'exit_price_source', "TEXT NOT NULL DEFAULT 'fresh'");
    this.addColumnIfMissing('closed_trades', 'score', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('closed_trades', 'source', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing('closed_trades', 'exit_tx_signature', 'TEXT');
    this.addColumnIfMissing('closed_trades', 'entry_network_fee_usd', 'REAL');
    this.addColumnIfMissing('closed_trades', 'exit_network_fee_usd', 'REAL');
    this.addColumnIfMissing('closed_trades', 'entry_network_fee_lamports', 'INTEGER');
    this.addColumnIfMissing('closed_trades', 'exit_network_fee_lamports', 'INTEGER');
    this.addColumnIfMissing('live_execution_journal', 'last_valid_block_height', 'INTEGER');
    this.addColumnIfMissing('scored_candidates', 'route_input_mint', 'TEXT');
    this.addColumnIfMissing('scored_candidates', 'route_input_symbol', 'TEXT');
    this.addColumnIfMissing('scored_candidates', 'strategy_id', "TEXT NOT NULL DEFAULT 'freshLaunchMomentum'");
    this.addColumnIfMissing('scored_candidates', 'sell_route_available', 'INTEGER');
    this.addColumnIfMissing('scored_candidates', 'mint_authority_revoked', 'INTEGER');
    this.addColumnIfMissing('scored_candidates', 'freeze_authority_revoked', 'INTEGER');
    this.addColumnIfMissing('scored_candidates', 'top5_holder_pct', 'REAL');
    this.addColumnIfMissing('scored_candidates', 'volume_acceleration_5m_z', 'REAL');
    this.addColumnIfMissing('scored_candidates', 'volume_acceleration_samples', 'INTEGER');
    this.addColumnIfMissing('scored_candidates', 'outcome_high_usd', 'REAL');
    this.addColumnIfMissing('scored_candidates', 'outcome_low_usd', 'REAL');
    this.addColumnIfMissing('scored_candidates', 'outcome_last_usd', 'REAL');
    this.addColumnIfMissing('scored_candidates', 'outcome_samples', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('scored_candidates', 'outcome_last_at', 'TEXT');
    this.addColumnIfMissing('scored_candidates', 'outcome_first_tp_at', 'TEXT');
    this.addColumnIfMissing('scored_candidates', 'outcome_first_sl_at', 'TEXT');
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

  private updateLiveExecutionJournal(
    id: string,
    status: LiveExecutionJournalEntry['status'],
    values: { signature?: string; error?: string; lastValidBlockHeight?: number } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE live_execution_journal
         SET status = @status,
             signature = COALESCE(@signature, signature),
             last_valid_block_height = COALESCE(@lastValidBlockHeight, last_valid_block_height),
             error = COALESCE(@error, error),
             updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        status,
        signature: values.signature ?? null,
        error: values.error ?? null,
        lastValidBlockHeight: values.lastValidBlockHeight ?? null,
        updatedAt: new Date().toISOString(),
      });
  }
}
