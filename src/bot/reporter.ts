import type { PaperPosition, PaperTrade } from '../types/domain.js';

export interface PositionOpenedEvent {
  position: PaperPosition;
  strategyId: string;
}

export interface PositionClosedEvent {
  trade: PaperTrade;
}

export interface CycleSummary {
  cashUsd: number;
  openPositions: number;
  closedThisCycle: number;
  openedThisCycle: number;
  eventsProcessed: number;
}

// Pluggable trade event sink. All methods are optional so partial reporters
// (e.g. one that only handles closes) don't need to implement everything.
// A future Telegram or webhook reporter drops in by implementing this interface.
export interface Reporter {
  onPositionOpened?(event: PositionOpenedEvent): void;
  onPositionClosed?(event: PositionClosedEvent): void;
  onCycleSummary?(summary: CycleSummary): void;
}

function sign(n: number): string {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

function holdMins(trade: PaperTrade): string {
  const ms = trade.closedAt.getTime() - trade.openedAt.getTime();
  return `${Math.round(ms / 60_000)}m`;
}

// Reporter that formats events as single-line log messages and routes them
// through the provided log callback (e.g. process.stdout.write or the run loop's
// onLog). Swap this for a TelegramReporter or WebhookReporter without changing
// any bot logic.
export function consoleReporter(onLog: (message: string) => void): Reporter {
  return {
    onPositionOpened({ position, strategyId }) {
      onLog(
        `[trade] OPENED ${position.id} ${position.token.chain.toUpperCase()} ${position.token.symbol}` +
          ` strategy=${strategyId} score=${position.score} entry=$${position.entryPriceUsd.toPrecision(4)}`,
      );
    },
    onPositionClosed({ trade }) {
      const pct = trade.pnlPct >= 0 ? `+${trade.pnlPct.toFixed(1)}%` : `${trade.pnlPct.toFixed(1)}%`;
      const networkFeeUsd = (trade.entryNetworkFeeUsd ?? 0) + (trade.exitNetworkFeeUsd ?? 0);
      const networkFeeLamports = (trade.entryNetworkFeeLamports ?? 0) + (trade.exitNetworkFeeLamports ?? 0);
      const fees = networkFeeUsd > 0
        ? ` networkFees=$${networkFeeUsd.toFixed(4)}`
        : networkFeeLamports > 0 ? ` networkFees=${networkFeeLamports}lamports` : '';
      onLog(
        `[trade] CLOSED ${trade.positionId} ${trade.token.chain.toUpperCase()} ${trade.token.symbol}` +
          ` reason=${trade.reason} pnl=${sign(trade.pnlUsd)} (${pct})${fees} hold=${holdMins(trade)}`,
      );
    },
    onCycleSummary({ cashUsd, openPositions, closedThisCycle, openedThisCycle, eventsProcessed }) {
      onLog(
        `[cycle] events=${eventsProcessed} opened=${openedThisCycle} closed=${closedThisCycle}` +
          ` open=${openPositions} cash=$${cashUsd.toFixed(2)}`,
      );
    },
  };
}
