import { env } from '../config/env';
import { getActiveTradeCount } from './queue';
import { createLogger } from '../utils/logger';

const log = createLogger('concurrency');

export function hasExecutionCapacity(): boolean {
  const active = getActiveTradeCount();
  const capacity = active < env.MAX_CONCURRENT_TRADES;

  if (!capacity) {
    log.debug('No execution capacity available', {
      active,
      max: env.MAX_CONCURRENT_TRADES,
    });
  }

  return capacity;
}

export function remainingCapacity(): number {
  return Math.max(0, env.MAX_CONCURRENT_TRADES - getActiveTradeCount());
}