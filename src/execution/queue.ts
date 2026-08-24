import { OpportunityCandidate } from '../strategies/common/opportunityCandidate';

const candidateQueue: OpportunityCandidate[] = [];
let resolveNext: (() => void) | null = null;
let currentResolve: ((value: OpportunityCandidate | null) => void) | null = null;

/**
 * Push a candidate to the queue and immediately wake up a waiting worker.
 */
export function pushCandidate(candidate: OpportunityCandidate): void {
  candidateQueue.push(candidate);
  
  if (resolveNext) {
    const wake = resolveNext;
    resolveNext = null;
    wake();
  }
}

/**
 * Blocking pop – resolves immediately when pushCandidate is called.
 */
export async function popCandidate(): Promise<OpportunityCandidate | null> {
  if (candidateQueue.length > 0) {
    return candidateQueue.shift()!;
  }

  return new Promise((resolve) => {
    currentResolve = resolve;
    resolveNext = () => {
      const candidate = candidateQueue.shift() || null;
      if (currentResolve) {
        const r = currentResolve;
        currentResolve = null;
        r(candidate);
      }
    };
  });
}

/**
 * Get the current queue length – used for monitoring.
 */
export function getQueueLength(): number {
  return candidateQueue.length;
}

/**
 * Get the number of active trades (workers processing candidates).
 * Used by concurrency.ts and healthServer.ts.
 */
let activeTrades = 0;

export function getActiveTradeCount(): number {
  return activeTrades;
}

export function incrementActiveTrades(): void {
  activeTrades++;
}

export function decrementActiveTrades(): void {
  if (activeTrades > 0) activeTrades--;
}