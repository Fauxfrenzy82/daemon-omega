import { OpportunityCandidate } from '../strategies/common/opportunityCandidate';

const candidateQueue: OpportunityCandidate[] = [];
let resolveNext: (() => void) | null = null;
let currentResolve: ((value: OpportunityCandidate | null) => void) | null = null;

/**
 * Push a candidate to the queue and immediately wake up a waiting worker.
 * This is the only write operation to the queue.
 */
export function pushCandidate(candidate: OpportunityCandidate): void {
  candidateQueue.push(candidate);
  
  // Wake up the first waiter in the same tick
  if (resolveNext) {
    const wake = resolveNext;
    resolveNext = null;
    wake();
  }
}

/**
 * Blocking pop. Worker calls this and waits (does not poll) until a candidate is available.
 * Resolves immediately in the same tick pushCandidate is called.
 */
export async function popCandidate(): Promise<OpportunityCandidate | null> {
  if (candidateQueue.length > 0) {
    return candidateQueue.shift()!;
  }

  // Block until pushCandidate wakes us
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

export function getQueueLength(): number {
  return candidateQueue.length;
}