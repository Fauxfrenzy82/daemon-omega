import { env } from '../config/env';
import { getRecentTradeOutcomes, logCircuitBreakerEvent } from '../db/logger';
import { createLogger } from '../utils/logger';
import { alertCircuitBreakerTripped, alertCircuitBreakerReset } from '../notifications/notifier';

const log = createLogger('circuitBreaker');

interface BreakerState {
  tripped: boolean;
  trippedAt: number | null;
  reason: string | null;
}

const state: BreakerState = {
  tripped: false,
  trippedAt: null,
  reason: null,
};

export async function evaluateCircuitBreaker(): Promise<void> {
  if (state.tripped) {
    const elapsed = Date.now() - (state.trippedAt ?? 0);
    if (elapsed >= env.CIRCUIT_BREAKER_COOLDOWN_MS) {
      resetBreaker('cooldown elapsed');
    }
    return;
  }

  const recent = await getRecentTradeOutcomes(env.MAX_CONSECUTIVE_LOSSES);

  if (recent.length < env.MAX_CONSECUTIVE_LOSSES) {
    return;
  }

  const allFailed = recent.every((t) => t.status === 'failed' || t.status === 'reverted');

  if (allFailed) {
    tripBreaker(`${env.MAX_CONSECUTIVE_LOSSES} consecutive failed/reverted trades`);
  }
}

function tripBreaker(reason: string): void {
  state.tripped = true;
  state.trippedAt = Date.now();
  state.reason = reason;

  log.error('Circuit breaker TRIPPED --- halting execution', { reason });
  logCircuitBreakerEvent('tripped', reason).catch(() => {});
  alertCircuitBreakerTripped(reason).catch(() => {});
}

function resetBreaker(reason: string): void {
  state.tripped = false;
  state.trippedAt = null;
  state.reason = null;

  log.info('Circuit breaker reset', { reason });
  logCircuitBreakerEvent('reset', reason).catch(() => {});
  alertCircuitBreakerReset(reason).catch(() => {});
}

export function isBreakerTripped(): boolean {
  return state.tripped;
}

export function manualTrip(reason: string): void {
  tripBreaker(`manual: ${reason}`);
}

export function manualReset(): void {
  resetBreaker('manual reset');
}