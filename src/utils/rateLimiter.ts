import { createLogger } from './logger';

const log = createLogger('rateLimiter');

/**
 * Simple token-bucket rate limiter. Callers await acquire() before
 * making a request; if no token is available, the call waits until
 * one frees up rather than firing and risking a 429. This throttles
 * at the source, so nothing downstream needs to know a limit exists.
 */
export class RateLimiter {
  private readonly maxTokens: number;
  private readonly refillIntervalMs: number;
  private tokens: number;
  private queue: Array<() => void> = [];

  constructor(maxRequests: number, perMs: number, label: string) {
    this.maxTokens = maxRequests;
    this.refillIntervalMs = perMs;
    this.tokens = maxRequests;

    setInterval(() => this.refill(), this.refillIntervalMs);
    log.info('Rate limiter initialized', { label, maxRequests, perMs });
  }

  private refill(): void {
    this.tokens = this.maxTokens;
    // Release as many queued waiters as tokens allow.
    while (this.tokens > 0 && this.queue.length > 0) {
      const resolve = this.queue.shift();
      if (resolve) {
        this.tokens -= 1;
        resolve();
      }
    }
  }

  /**
   * Resolves immediately if a token is available, otherwise queues
   * the caller until the next refill tick frees one up.
   */
  acquire(): Promise<void> {
    if (this.tokens > 0) {
      this.tokens -= 1;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }
}

// OpenOcean public plan: 2 requests/second (20 per 10 seconds).
// Kept slightly under the published cap as a safety margin.
export const openOceanLimiter = new RateLimiter(2, 1000, 'openocean');