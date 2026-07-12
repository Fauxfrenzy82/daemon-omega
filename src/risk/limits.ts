import { env } from '../config/env';
import { createLogger } from '../utils/logger';

const log = createLogger('risk-limits');

export interface PositionSizeCheck {
  allowed: boolean;
  cappedSizeUsd: number;
  reason?: string;
}

export function checkPositionSize(requestedUsd: number, pairMaxUsd: number): PositionSizeCheck {
  const cap = Math.min(requestedUsd, pairMaxUsd, env.MAX_POSITION_SIZE_USD);

  if (cap <= 0) {
    return { allowed: false, cappedSizeUsd: 0, reason: 'computed position size is zero or negative' };
  }

  return { allowed: true, cappedSizeUsd: cap };
}

export interface ConcurrencyState {
  activeTrades: number;
}

export function canStartNewTrade(state: ConcurrencyState): boolean {
  const allowed = state.activeTrades < env.MAX_CONCURRENT_TRADES;

  if (!allowed) {
    log.debug('Max concurrent trades reached', {
      active: state.activeTrades,
      max: env.MAX_CONCURRENT_TRADES,
    });
  }

  return allowed;
}

export function checkGasPriceLimit(currentGasPriceGwei: number): boolean {
  const withinLimit = currentGasPriceGwei <= env.MAX_GAS_PRICE_GWEI;

  if (!withinLimit) {
    log.warn('Gas price exceeds configured maximum', {
      currentGasPriceGwei,
      maxGasPriceGwei: env.MAX_GAS_PRICE_GWEI,
    });
  }

  return withinLimit;
}