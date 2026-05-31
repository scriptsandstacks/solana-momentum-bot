import { describe, expect, it } from 'vitest';
import { trackCandidateOutcomes, type TrackOutcomesStore } from '../src/bot/trackOutcomes.js';
import type { ScoredOutcomeUpdate, TrackableScoredCandidateRow } from '../src/storage/sqliteStore.js';

function fakeStore(rows: TrackableScoredCandidateRow[]) {
  const updates: ScoredOutcomeUpdate[] = [];
  let staleCutoff = '';
  return {
    listTrackableScoredCandidates: () => rows,
    markStaleScoredOutcomesDone: (cutoffIso: string) => {
      staleCutoff = cutoffIso;
      return 0;
    },
    recordScoredOutcome: (update: ScoredOutcomeUpdate) => updates.push(update),
    _updates: updates,
    get _staleCutoff() {
      return staleCutoff;
    },
  } satisfies TrackOutcomesStore & { _updates: ScoredOutcomeUpdate[]; readonly _staleCutoff: string };
}

const now = new Date('2026-01-01T00:20:00.000Z');

function row(overrides: Partial<TrackableScoredCandidateRow> & { id: number }): TrackableScoredCandidateRow {
  return {
    address: `mint-${overrides.id}`,
    scoredPriceUsd: 0.01,
    createdAt: '2026-01-01T00:10:00.000Z', // 10 min before `now`
    outcomeHighUsd: null,
    outcomeLowUsd: null,
    ...overrides,
  };
}

describe('trackCandidateOutcomes', () => {
  it('records high/low/last seeded from the scored price and keeps tracking within the horizon', async () => {
    const store = fakeStore([row({ id: 1 })]);

    const result = await trackCandidateOutcomes({
      store,
      horizonMinutes: 45,
      now,
      fetchPrices: async () => new Map([['mint-1', 0.013]]),
    });

    expect(result).toMatchObject({ tracked: 1, updated: 1, completed: 0, missingPrice: 0 });
    expect(store._updates[0]).toMatchObject({
      id: 1,
      outcomeHighUsd: 0.013, // max(scored 0.01, 0.013)
      outcomeLowUsd: 0.01, // min(scored 0.01, 0.013) — seeded from the baseline
      outcomeLastUsd: 0.013,
      done: false, // 10 min held < 45 min horizon
    });
  });

  it('ratchets against prior high/low and finalizes once the horizon elapses', async () => {
    const store = fakeStore([
      row({ id: 1, createdAt: '2026-01-01T00:00:00.000Z', outcomeHighUsd: 0.02, outcomeLowUsd: 0.009 }),
    ]);

    const result = await trackCandidateOutcomes({
      store,
      horizonMinutes: 15, // 20 min held >= 15 → done
      now,
      fetchPrices: async () => new Map([['mint-1', 0.012]]),
    });

    expect(store._updates[0]).toMatchObject({
      outcomeHighUsd: 0.02, // unchanged: 0.012 < prior high
      outcomeLowUsd: 0.009, // unchanged: 0.012 > prior low
      outcomeLastUsd: 0.012,
      done: true,
    });
    expect(result.completed).toBe(1);
  });

  it('counts missing prices and finalizes stale rows via the cutoff', async () => {
    const store = fakeStore([row({ id: 1 })]);

    const result = await trackCandidateOutcomes({
      store,
      horizonMinutes: 45,
      now,
      fetchPrices: async () => new Map(), // no price this pass
    });

    expect(result.missingPrice).toBe(1);
    expect(store._updates).toHaveLength(0);
    // Cutoff = now - 45m.
    expect(store._staleCutoff).toBe('2025-12-31T23:35:00.000Z');
  });
});
