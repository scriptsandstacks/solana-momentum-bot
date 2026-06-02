import type { OpportunityScore, TokenCandidate } from '../types/domain.js';

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function scoreTokenCandidate(candidate: TokenCandidate): OpportunityScore {
  const reasons: string[] = [];
  const risks: string[] = [];
  let total = 0;

  if (candidate.liquidityUsd >= 50_000) {
    total += 24;
    reasons.push('strong_liquidity');
  } else if (candidate.liquidityUsd >= 10_000) {
    total += 18;
    reasons.push('liquidity_ok');
  } else {
    total -= 14;
    risks.push('low_liquidity');
  }

  if (candidate.volume5mUsd >= 20_000) {
    total += 20;
    reasons.push('high_5m_volume');
  } else if (candidate.volume5mUsd >= 5_000) {
    total += 14;
    reasons.push('volume_ok');
  } else {
    total += 3;
    risks.push('low_5m_volume');
  }

  const totalTrades = candidate.buys5m + candidate.sells5m;
  const buyRatio = totalTrades === 0 ? 0 : candidate.buys5m / totalTrades;
  if (buyRatio >= 0.65 && totalTrades >= 50) {
    total += 16;
    reasons.push('buy_pressure');
  } else if (buyRatio >= 0.5 && totalTrades >= 20) {
    total += 9;
    reasons.push('balanced_flow');
  } else {
    risks.push('weak_buy_pressure');
  }

  if (candidate.ageMinutes >= 5 && candidate.ageMinutes <= 90) {
    total += 10;
    reasons.push('fresh_but_not_instant');
  } else if (candidate.ageMinutes < 5) {
    total += 2;
    risks.push('too_new');
  } else {
    total += 5;
    risks.push('older_token');
  }

  if (candidate.priceChange5mPct > 0 && candidate.priceChange5mPct <= 40) {
    total += 10;
    reasons.push('healthy_momentum');
  } else if (candidate.priceChange5mPct > 40) {
    total += 3;
    risks.push('possibly_overextended');
  } else {
    risks.push('negative_momentum');
  }

  if (candidate.routeAvailable) {
    total += 15;
    reasons.push('route_available');
  } else {
    total -= 25;
    risks.push('no_route');
  }

  if (candidate.estimatedSlippageBps <= 300) {
    total += 5;
    reasons.push('low_slippage');
  } else if (candidate.estimatedSlippageBps > 500) {
    total -= 10;
    risks.push('high_slippage');
  }

  // Explicit false = sell probe ran and found no route (honeypot). undefined = not checked; no penalty.
  if (candidate.sellRouteAvailable === false) {
    total -= 50;
    risks.push('no_sell_route');
  }

  // On-chain authority checks. false = authority still held (rug risk); undefined = not checked.
  if (candidate.mintAuthorityRevoked === false) {
    total -= 20;
    risks.push('mint_authority_held');
  } else if (candidate.mintAuthorityRevoked === true) {
    total += 5;
    reasons.push('mint_authority_revoked');
  }

  if (candidate.freezeAuthorityRevoked === false) {
    total -= 15;
    risks.push('freeze_authority_held');
  } else if (candidate.freezeAuthorityRevoked === true) {
    total += 3;
    reasons.push('freeze_authority_revoked');
  }

  if (candidate.top5HolderPct !== undefined) {
    if (candidate.top5HolderPct >= 80) {
      total -= 60;
      risks.push('holder_concentration_high');
    } else if (candidate.top5HolderPct <= 50) {
      total += 3;
      reasons.push('holder_distribution_ok');
    }
  }

  const bounded = clampScore(total);
  const recommendation = bounded >= 75 ? 'paper_trade' : bounded >= 50 ? 'watch' : 'ignore';

  return { total: bounded, recommendation, reasons, risks };
}
