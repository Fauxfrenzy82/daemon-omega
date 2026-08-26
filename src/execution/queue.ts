// src/execution/queue.ts
import { OpportunityCandidate } from '../strategies/common/opportunityCandidate';

const candidateQueue: OpportunityCandidate[] = [];

// FIX: was a single-slot (resolveNext/currentResolve). When multiple workers call
// popCandidate concurrently while the queue is empty, each overwrites the previous
// slot — orphaning all but the last worker's promise forever. Those workers hang
// indefinitely, silently shrinking the pool. Replace with a FIFO waiter array so
// every blocked worker gets its own resolver and pushCandidate wakes the oldest one.
const waiters: Array<(candidate: OpportunityCandidate | null) => void> = [];

/**
 * Push a candidate to the queue and immediately wake up the oldest waiting worker.
 * If no workers are waiting, enqueue for the next popCandidate call.
 */
export function pushCandidate(candidate: OpportunityCandidate): void {
  if (waiters.length > 0) {
    // Hand directly to the oldest blocked worker — bypass the queue entirely
    const resolve = waiters.shift()!;
    resolve(candidate);
  } else {
    candidateQueue.push(candidate);
  }
}

/**
 * Blocking pop — resolves immediately if a candidate is already queued,
 * otherwise parks this worker in the waiter list until pushCandidate fires.
 */
export async function popCandidate(): Promise<OpportunityCandidate | null> {
  if (candidateQueue.length > 0) {
    return candidateQueue.shift()!;
  }

  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

/**
 * Get the current queue length — used for monitoring.
 */
export function getQueueLength(): number {
  return candidateQueue.length;
}

/**
 * Get the number of active trades (workers processing candidates).
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