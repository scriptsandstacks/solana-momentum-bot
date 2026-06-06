import type { Reporter, PositionOpenedEvent, PositionClosedEvent, CycleSummary } from './reporter.js';

// Discord embed color constants (decimal)
const COLOR_GREEN = 0x2ecc71;
const COLOR_RED = 0xe74c3c;
const COLOR_GREY = 0x95a5a6;

interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

interface DiscordWebhookPayload {
  embeds: DiscordEmbed[];
}

// Formats trade events as Discord embeds and posts them to a webhook URL.
// All sends are fire-and-forget — a failed webhook never blocks the run loop.
export function discordReporter(
  webhookUrl: string,
  onError?: (message: string) => void,
): Reporter {
  async function send(payload: DiscordWebhookPayload): Promise<void> {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        onError?.(`[discord] webhook POST failed: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      onError?.(`[discord] webhook error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    onPositionOpened({ position, strategyId }: PositionOpenedEvent) {
      void send({
        embeds: [
          {
            title: `OPENED — ${position.token.symbol} (${position.token.chain.toUpperCase()})`,
            color: COLOR_GREEN,
            fields: [
              { name: 'Strategy', value: strategyId, inline: true },
              { name: 'Score', value: String(position.score), inline: true },
              { name: 'Entry price', value: `$${position.entryPriceUsd.toPrecision(4)}`, inline: true },
              { name: 'Quantity', value: position.quantity.toFixed(4), inline: true },
              { name: 'Position ID', value: position.id.slice(0, 8), inline: true },
            ],
            timestamp: position.openedAt.toISOString(),
          },
        ],
      });
    },

    onPositionClosed({ trade }: PositionClosedEvent) {
      const profit = trade.pnlUsd >= 0;
      const pct = trade.pnlPct >= 0
        ? `+${trade.pnlPct.toFixed(2)}%`
        : `${trade.pnlPct.toFixed(2)}%`;
      const pnl = trade.pnlUsd >= 0
        ? `+$${trade.pnlUsd.toFixed(2)}`
        : `-$${Math.abs(trade.pnlUsd).toFixed(2)}`;
      const holdMs = trade.closedAt.getTime() - trade.openedAt.getTime();
      const holdMins = Math.round(holdMs / 60_000);
      const networkFeeUsd = (trade.entryNetworkFeeUsd ?? 0) + (trade.exitNetworkFeeUsd ?? 0);
      const feeStr = networkFeeUsd > 0 ? `$${networkFeeUsd.toFixed(4)}` : 'n/a (paper)';

      const fields: DiscordEmbed['fields'] = [
        { name: 'P&L', value: `${pnl} (${pct})`, inline: true },
        { name: 'Reason', value: trade.reason, inline: true },
        { name: 'Hold time', value: `${holdMins}m`, inline: true },
        { name: 'Entry price', value: `$${trade.entryPriceUsd.toPrecision(4)}`, inline: true },
        { name: 'Exit price', value: `$${trade.exitPriceUsd.toPrecision(4)}`, inline: true },
        { name: 'Network fees', value: feeStr, inline: true },
      ];

      if (trade.exitTxSignature) {
        fields.push({ name: 'Tx', value: trade.exitTxSignature.slice(0, 20) + '…', inline: false });
      }

      void send({
        embeds: [
          {
            title: `CLOSED — ${trade.token.symbol} (${trade.token.chain.toUpperCase()})`,
            color: profit ? COLOR_GREEN : COLOR_RED,
            fields,
            footer: { text: `Position ${trade.positionId.slice(0, 8)}` },
            timestamp: trade.closedAt.toISOString(),
          },
        ],
      });
    },

    onCycleSummary(summary: CycleSummary) {
      // Only post a cycle summary when something actually happened this cycle —
      // silent cycles (no opens, no closes) don't need a Discord notification.
      if (summary.openedThisCycle === 0 && summary.closedThisCycle === 0) return;

      void send({
        embeds: [
          {
            title: 'Cycle summary',
            color: COLOR_GREY,
            fields: [
              { name: 'Opened', value: String(summary.openedThisCycle), inline: true },
              { name: 'Closed', value: String(summary.closedThisCycle), inline: true },
              { name: 'Open positions', value: String(summary.openPositions), inline: true },
              { name: 'Cash', value: `$${summary.cashUsd.toFixed(2)}`, inline: true },
              { name: 'Events processed', value: String(summary.eventsProcessed), inline: true },
            ],
          },
        ],
      });
    },
  };
}

// Build the Discord embed payload for a position-opened event.
// Exported for unit testing without a real webhook URL.
export function buildOpenedEmbed(event: PositionOpenedEvent): DiscordWebhookPayload {
  const { position, strategyId } = event;
  return {
    embeds: [
      {
        title: `OPENED — ${position.token.symbol} (${position.token.chain.toUpperCase()})`,
        color: COLOR_GREEN,
        fields: [
          { name: 'Strategy', value: strategyId, inline: true },
          { name: 'Score', value: String(position.score), inline: true },
          { name: 'Entry price', value: `$${position.entryPriceUsd.toPrecision(4)}`, inline: true },
          { name: 'Quantity', value: position.quantity.toFixed(4), inline: true },
          { name: 'Position ID', value: position.id.slice(0, 8), inline: true },
        ],
        timestamp: position.openedAt.toISOString(),
      },
    ],
  };
}

// Build the Discord embed payload for a position-closed event.
// Exported for unit testing without a real webhook URL.
export function buildClosedEmbed(event: PositionClosedEvent): DiscordWebhookPayload {
  const { trade } = event;
  const profit = trade.pnlUsd >= 0;
  const pct = trade.pnlPct >= 0
    ? `+${trade.pnlPct.toFixed(2)}%`
    : `${trade.pnlPct.toFixed(2)}%`;
  const pnl = trade.pnlUsd >= 0
    ? `+$${trade.pnlUsd.toFixed(2)}`
    : `-$${Math.abs(trade.pnlUsd).toFixed(2)}`;
  const holdMs = trade.closedAt.getTime() - trade.openedAt.getTime();
  const holdMins = Math.round(holdMs / 60_000);
  const networkFeeUsd = (trade.entryNetworkFeeUsd ?? 0) + (trade.exitNetworkFeeUsd ?? 0);
  const feeStr = networkFeeUsd > 0 ? `$${networkFeeUsd.toFixed(4)}` : 'n/a (paper)';

  const fields: DiscordEmbed['fields'] = [
    { name: 'P&L', value: `${pnl} (${pct})`, inline: true },
    { name: 'Reason', value: trade.reason, inline: true },
    { name: 'Hold time', value: `${holdMins}m`, inline: true },
    { name: 'Entry price', value: `$${trade.entryPriceUsd.toPrecision(4)}`, inline: true },
    { name: 'Exit price', value: `$${trade.exitPriceUsd.toPrecision(4)}`, inline: true },
    { name: 'Network fees', value: feeStr, inline: true },
  ];

  if (trade.exitTxSignature) {
    fields.push({ name: 'Tx', value: trade.exitTxSignature.slice(0, 20) + '…', inline: false });
  }

  return {
    embeds: [
      {
        title: `CLOSED — ${trade.token.symbol} (${trade.token.chain.toUpperCase()})`,
        color: profit ? COLOR_GREEN : COLOR_RED,
        fields,
        footer: { text: `Position ${trade.positionId.slice(0, 8)}` },
        timestamp: trade.closedAt.toISOString(),
      },
    ],
  };
}
