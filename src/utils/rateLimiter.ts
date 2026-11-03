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

/**
 * Spacing limiter: guarantees a minimum gap between the START of any two
 * requests, no matter how many callers hit it at the same instant.
 * Unlike a bucket, it can never allow two requests inside the same window.
 * Slots are reserved synchronously, so concurrent callers queue in order.
 */
export class SpacedRateLimiter {
  private nextSlotAt = 0;
  private readonly minIntervalMs: number;

  constructor(minIntervalMs: number, label: string) {
    this.minIntervalMs = minIntervalMs;
    log.info('Spaced rate limiter initialized', { label, minIntervalMs });
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = slot + this.minIntervalMs;
    const wait = slot - now;
    if (wait > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
  }
}

// OpenOcean public plan: 2 requests/second (20 per 10 seconds).
// Kept slightly under the published cap as a safety margin.
export const openOceanLimiter = new RateLimiter(2, 1000, 'openocean');

// Enso plan: 1 request/second. 1100ms spacing leaves a safety margin.
// Override with ENSO_MIN_INTERVAL_MS after upgrading your Enso plan
// (e.g. 120 for ~8 rps).
const ENSO_MIN_INTERVAL_MS = Number(process.env.ENSO_MIN_INTERVAL_MS) || 1100;
export const ensoApiLimiter = new SpacedRateLimiter(ENSO_MIN_INTERVAL_MS, 'enso-api');