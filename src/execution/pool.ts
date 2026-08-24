import { createLogger } from '../utils/logger';
import { Worker } from './worker';
import { env } from '../config/env';

const log = createLogger('workerPool');

const WORKER_COUNT = env.WORKER_POOL_SIZE ?? 3;
let workers: Worker[] = [];
let isRunning = false;

export function startWorkerPool(): void {
  if (isRunning) return;
  isRunning = true;

  log.info(`Starting worker pool with ${WORKER_COUNT} workers`);
  
  for (let i = 0; i < WORKER_COUNT; i++) {
    const worker = new Worker(i);
    workers.push(worker);
    worker.start().catch((err) => {
      log.error(`Worker ${i} crashed`, { error: String(err) });
    });
  }
}

export function stopWorkerPool(): void {
  isRunning = false;
  for (const worker of workers) {
    worker.stop();
  }
  workers = [];
}

export function getActiveWorkerCount(): number {
  return workers.length;
}