import { createLogger } from '../utils/logger';
import { OpportunityCandidate } from '../strategies/common/opportunityCandidate';
import { popCandidate } from './queue';
import { processCandidate } from './processor';

const log = createLogger('worker');

export class Worker {
  private running = true;
  private id: number;

  constructor(id: number) {
    this.id = id;
  }

  async start(): Promise<void> {
    log.info(`Worker ${this.id} started`);

    while (this.running) {
      // BLOCKS until a candidate is available – no polling, no timeout
      const candidate = await popCandidate();
      
      if (!candidate) {
        continue;
      }

      try {
        log.debug(`Worker ${this.id} processing ${candidate.id}`);
        await processCandidate(candidate);
      } catch (err) {
        log.error(`Worker ${this.id} failed processing ${candidate.id}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}