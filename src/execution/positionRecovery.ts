// Pure transformation functions for the `recover-positions` command.
// These turn reconciliation results into the SQLite records the bot needs to
// resume normal tracking. No I/O — all side effects happen in the CLI layer.

import type { PaperPosition, PaperTrade, TokenCandidate } from '../types/domain.js';
import type { OrphanedHolding, StalePosition } from './walletReconciler.js';

export const RECOVERY_STRATEGY_ID = 'freshLaunchMomentum';

// ─── stale recovery ──────────────────────────────────────────────────────────
// A stale position exists in SQLite but the wallet holds no tokens. We close
// it at the last known mark price so the slot is freed and analytics reflects
// the position as closed.

export interface StaleRecovery {
  type: 'stale';
  position: PaperPosition;
  trade: PaperTrade;
  exitPriceUsd: number;
  pnlUsd: number;
}

export function buildStaleRecovery(position: PaperPosition, closedAt = new Date()): StaleRecovery {
  // Prefer the last observed mark; fall back to entry price when never re-priced.
  const exitPriceUsd = position.lastMarkUsd ?? position.entryPriceUsd;
  const exitPriceSource: NonNullable<PaperTrade['exitPriceSource']> =
    position.lastMarkUsd !== undefined && position.lastMarkUsd !== position.entryPriceUsd
      ? 'last_mark'
      : 'entry_fallback';

  const entryValueUsd = position.entryPriceUsd * position.quantity;
  const exitValueUsd = exitPriceUsd * position.quantity;
  const pnlUsd = exitValueUsd - entryValueUsd;

  const trade: PaperTrade = {
    positionId: position.id,
    token: position.token,
    score: position.score,
    entryPriceUsd: position.entryPriceUsd,
    exitPriceUsd,
    quantity: position.quantity,
    openedAt: position.openedAt,
    closedAt,
    reason: 'manual',
    exitPriceSource,
    pnlUsd,
    pnlPct: (pnlUsd / entryValueUsd) * 100,
  };

  return { type: 'stale', position, trade, exitPriceUsd, pnlUsd };
}

// ─── orphaned recovery ───────────────────────────────────────────────────────
// An orphaned holding is in the wallet but absent from SQLite — typically from
// a crash after a confirmed swap but before saveOpenPosition ran. We insert a
// synthetic open_positions row so the bot can track marks and exit normally.
// The entry price is the CURRENT market price, which is approximate; the
// original buy price would require transaction parsing.

export interface OrphanedRecovery {
  type: 'orphaned';
  holding: OrphanedHolding;
  position: PaperPosition;
  // undefined when market data was not available; this recovery cannot proceed.
  currentPriceUsd: number | undefined;
}

export function buildOrphanedRecovery(
  holding: OrphanedHolding,
  candidate: TokenCandidate | undefined,
  positionId: string,
  openedAt = new Date(),
): OrphanedRecovery {
  if (!candidate || candidate.priceUsd <= 0) {
    return { type: 'orphaned', holding, position: undefined as any, currentPriceUsd: undefined };
  }

  const token: TokenCandidate = { ...candidate, strategyId: RECOVERY_STRATEGY_ID };
  const position: PaperPosition = {
    id: positionId,
    token,
    score: 0,
    entryPriceUsd: candidate.priceUsd,
    quantity: holding.uiAmount,
    openedAt,
    highWaterMarkUsd: candidate.priceUsd,
    lastMarkUsd: candidate.priceUsd,
  };

  return { type: 'orphaned', holding, position, currentPriceUsd: candidate.priceUsd };
}

// ─── rendering ───────────────────────────────────────────────────────────────

export function renderRecoveryPlan(
  staleRecoveries: StaleRecovery[],
  orphanedRecoveries: OrphanedRecovery[],
): string {
  const lines: string[] = [];

  if (staleRecoveries.length === 0 && orphanedRecoveries.length === 0) {
    lines.push('No recovery needed — wallet and SQLite are in sync.');
    return lines.join('\n');
  }

  lines.push(`Recovery plan: ${staleRecoveries.length} stale + ${orphanedRecoveries.length} orphaned`);
  lines.push('');

  for (const r of staleRecoveries) {
    const p = r.position;
    const pnlSign = r.pnlUsd >= 0 ? '+' : '';
    lines.push(`  STALE  ${p.id}  ${p.token.symbol}`);
    lines.push(`         entry=$${p.entryPriceUsd.toFixed(6)} × ${p.quantity.toFixed(2)} qty`);
    lines.push(`         exit =$${r.exitPriceUsd.toFixed(6)} (last mark)`);
    lines.push(`         pnl  =${pnlSign}$${r.pnlUsd.toFixed(4)}`);
    lines.push(`         action: close position in SQLite (reason=manual)`);
    lines.push('');
  }

  for (const r of orphanedRecoveries) {
    if (r.currentPriceUsd === undefined) {
      lines.push(`  ORPHANED  mint=${r.holding.mint}  amount=${r.holding.uiAmount.toFixed(4)}`);
      lines.push(`            SKIPPED — could not fetch market price; close manually`);
      lines.push('');
      continue;
    }
    lines.push(`  ORPHANED  ${r.position.id}  ${r.position.token.symbol}`);
    lines.push(`            mint=${r.holding.mint}`);
    lines.push(`            amount=${r.holding.uiAmount.toFixed(4)}  current=$${r.currentPriceUsd.toFixed(6)}`);
    lines.push(`            NOTE: entry price is approximate (current price, not original buy price)`);
    lines.push(`            action: insert synthetic open_positions row`);
    lines.push('');
  }

  return lines.join('\n');
}

export function renderRecoverySummary(
  staleDone: number,
  orphanedDone: number,
  skipped: number,
): string {
  const parts: string[] = [];
  if (staleDone > 0) parts.push(`${staleDone} stale position(s) closed`);
  if (orphanedDone > 0) parts.push(`${orphanedDone} orphaned holding(s) registered`);
  if (skipped > 0) parts.push(`${skipped} skipped (no market price available)`);
  return parts.length > 0 ? `Recovery complete: ${parts.join(', ')}.` : 'Nothing to recover.';
}

// ─── helpers used by both recovery types ─────────────────────────────────────

export function describeStalePosition(s: StalePosition): string {
  return `${s.positionId}  ${s.symbol}  mint=${s.mint}  expected=${s.expectedQuantity.toFixed(4)}  on-chain=${s.actualUiAmount.toFixed(4)}`;
}

export function describeOrphanedHolding(h: OrphanedHolding): string {
  return `mint=${h.mint}  amount=${h.uiAmount.toFixed(4)}`;
}
