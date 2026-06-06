import { describe, expect, it } from 'vitest';
import { buildOpenedEmbed, buildClosedEmbed } from '../src/bot/discordReporter.js';
import type { PaperPosition, PaperTrade, TokenCandidate } from '../src/types/domain.js';

const token: TokenCandidate = {
  chain: 'solana',
  address: 'TokenMint1234',
  symbol: 'BONK',
  name: 'Bonk',
  pairAddress: 'PairAddr1234',
  priceUsd: 0.000015,
  liquidityUsd: 50_000,
  volume5mUsd: 8_000,
  volume1hUsd: 80_000,
  priceChange5mPct: 12,
  buys5m: 40,
  sells5m: 10,
  ageMinutes: 5,
  source: 'pumpportal',
  routeAvailable: true,
  estimatedSlippageBps: 200,
};

const position: PaperPosition = {
  id: 'pos-abc-12345678',
  token,
  score: 85,
  entryPriceUsd: 0.000015,
  quantity: 5_000_000,
  openedAt: new Date('2026-06-06T12:00:00.000Z'),
  highWaterMarkUsd: 0.000015,
};

const trade: PaperTrade = {
  positionId: 'pos-abc-12345678',
  token,
  score: 85,
  entryPriceUsd: 0.000015,
  exitPriceUsd: 0.000022,
  quantity: 5_000_000,
  openedAt: new Date('2026-06-06T12:00:00.000Z'),
  closedAt: new Date('2026-06-06T12:08:00.000Z'),
  reason: 'take_profit',
  pnlUsd: 35.0,
  pnlPct: 46.67,
};

describe('buildOpenedEmbed', () => {
  it('includes symbol and chain in title', () => {
    const payload = buildOpenedEmbed({ position, strategyId: 'freshLaunchMomentum' });
    expect(payload.embeds[0].title).toContain('BONK');
    expect(payload.embeds[0].title).toContain('SOLANA');
    expect(payload.embeds[0].title).toContain('OPENED');
  });

  it('uses green color', () => {
    const payload = buildOpenedEmbed({ position, strategyId: 'freshLaunchMomentum' });
    expect(payload.embeds[0].color).toBe(0x2ecc71);
  });

  it('includes strategy, score, and entry price fields', () => {
    const payload = buildOpenedEmbed({ position, strategyId: 'freshLaunchMomentum' });
    const fields = payload.embeds[0].fields ?? [];
    expect(fields.find((f) => f.name === 'Strategy')?.value).toBe('freshLaunchMomentum');
    expect(fields.find((f) => f.name === 'Score')?.value).toBe('85');
    expect(fields.find((f) => f.name === 'Entry price')?.value).toContain('$');
  });

  it('truncates position ID to 8 characters', () => {
    const payload = buildOpenedEmbed({ position, strategyId: 'freshLaunchMomentum' });
    const idField = payload.embeds[0].fields?.find((f) => f.name === 'Position ID');
    expect(idField?.value).toBe('pos-abc-');
  });

  it('sets timestamp to openedAt', () => {
    const payload = buildOpenedEmbed({ position, strategyId: 'freshLaunchMomentum' });
    expect(payload.embeds[0].timestamp).toBe('2026-06-06T12:00:00.000Z');
  });
});

describe('buildClosedEmbed', () => {
  it('includes symbol and chain in title', () => {
    const payload = buildClosedEmbed({ trade });
    expect(payload.embeds[0].title).toContain('BONK');
    expect(payload.embeds[0].title).toContain('SOLANA');
    expect(payload.embeds[0].title).toContain('CLOSED');
  });

  it('uses green color for a winning trade', () => {
    const payload = buildClosedEmbed({ trade });
    expect(payload.embeds[0].color).toBe(0x2ecc71);
  });

  it('uses red color for a losing trade', () => {
    const payload = buildClosedEmbed({ trade: { ...trade, pnlUsd: -10, pnlPct: -20 } });
    expect(payload.embeds[0].color).toBe(0xe74c3c);
  });

  it('includes pnl, reason, and hold time fields', () => {
    const payload = buildClosedEmbed({ trade });
    const fields = payload.embeds[0].fields ?? [];
    const pnlField = fields.find((f) => f.name === 'P&L');
    expect(pnlField?.value).toContain('+$35.00');
    expect(pnlField?.value).toContain('+46.67%');
    expect(fields.find((f) => f.name === 'Reason')?.value).toBe('take_profit');
    expect(fields.find((f) => f.name === 'Hold time')?.value).toBe('8m');
  });

  it('shows paper label for network fees when none are present', () => {
    const payload = buildClosedEmbed({ trade });
    const feeField = payload.embeds[0].fields?.find((f) => f.name === 'Network fees');
    expect(feeField?.value).toBe('n/a (paper)');
  });

  it('shows USD fee value for live trades with fee data', () => {
    const liveTrade: PaperTrade = {
      ...trade,
      entryNetworkFeeUsd: 0.002,
      exitNetworkFeeUsd: 0.002,
    };
    const payload = buildClosedEmbed({ trade: liveTrade });
    const feeField = payload.embeds[0].fields?.find((f) => f.name === 'Network fees');
    expect(feeField?.value).toBe('$0.0040');
  });

  it('includes tx signature field when present', () => {
    const liveTrade: PaperTrade = {
      ...trade,
      exitTxSignature: 'abcdefghijklmnopqrstuvwxyz1234567890ABCDEF',
    };
    const payload = buildClosedEmbed({ trade: liveTrade });
    const txField = payload.embeds[0].fields?.find((f) => f.name === 'Tx');
    expect(txField).toBeDefined();
    expect(txField?.value).toContain('…');
  });

  it('omits tx signature field when not present', () => {
    const payload = buildClosedEmbed({ trade });
    const txField = payload.embeds[0].fields?.find((f) => f.name === 'Tx');
    expect(txField).toBeUndefined();
  });

  it('sets footer with truncated position ID', () => {
    const payload = buildClosedEmbed({ trade });
    expect(payload.embeds[0].footer?.text).toContain('pos-abc-');
  });

  it('formats a losing trade pnl with minus sign', () => {
    const loser: PaperTrade = { ...trade, pnlUsd: -8.5, pnlPct: -15.3 };
    const payload = buildClosedEmbed({ trade: loser });
    const pnlField = payload.embeds[0].fields?.find((f) => f.name === 'P&L');
    expect(pnlField?.value).toContain('-$8.50');
    expect(pnlField?.value).toContain('-15.30%');
  });
});
