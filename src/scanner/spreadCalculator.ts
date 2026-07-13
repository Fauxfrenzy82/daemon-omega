import { QuoteResult } from './priceSource';
import { createLogger } from '../utils/logger';

const log = createLogger('spreadCalculator');

export interface SpreadOpportunity {
  pairId: string;
  buySource: string;
  sellSource: string;
  buyQuote: QuoteResult;
  sellQuote: QuoteResult;
  spreadBps: number;
}

/**
 * Finds the best spread across ALL quotes (executable or not).
 * Execution capability is checked separately after this.
 */
export function findBestSpread(pairId: string, quotes: QuoteResult[]): SpreadOpportunity | null {
  const valid = quotes.filter((q) => q && q.price > 0);

  if (valid.length < 2) {
    log.debug(`Not enough valid quotes to compare for ${pairId}`, { count: valid.length });
    return null;
  }

  const priceLog = valid.map(q => `${q.source}: ${q.price.toFixed(6)}`).join(', ');
  log.debug(`Valid quotes for ${pairId}: ${priceLog}`);

  let best: SpreadOpportunity | null = null;

  for (let i = 0; i < valid.length; i++) {
    for (let j = 0; j < valid.length; j++) {
      if (i === j) continue;

      const buyQuote = valid[i];
      const sellQuote = valid[j];

      if (buyQuote.source === sellQuote.source) continue;

      const spread = (sellQuote.price - buyQuote.price) / buyQuote.price;
      const spreadBps = spread * 10000;

      if (spreadBps > 0 && (!best || spreadBps > best.spreadBps)) {
        best = {
          pairId,
          buySource: buyQuote.source,
          sellSource: sellQuote.source,
          buyQuote,
          sellQuote,
          spreadBps,
        };
      }
    }
  }

  if (best) {
    log.debug(`Best spread for ${pairId}: ${best.spreadBps.toFixed(2)} bps (${best.buySource} → ${best.sellSource})`);
  } else {
    log.debug(`No positive spread found for ${pairId}`);
  }

  return best;
}