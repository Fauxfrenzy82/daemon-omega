import { createLogger } from './logger';

const logger = createLogger('retry');

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
  shouldRetry?: (err: unknown) => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exp = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exp + jitter, maxDelayMs);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    retries = 3,
    baseDelayMs = 250,
    maxDelayMs = 5000,
    label = 'operation',
    shouldRetry = () => true,
  } = options;

  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !shouldRetry(err)) {
        logger.error(`${label} failed after ${attempt + 1} attempt(s)`, {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      const delay = computeDelay(attempt, baseDelayMs, maxDelayMs);
      logger.warn(`${label} failed, retrying in ${Math.round(delay)}ms`, {
        attempt: attempt + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(delay);
    }
  }

  throw lastErr;
}

export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('network') ||
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('fetch failed')
  );
}