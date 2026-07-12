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

export function findBestSpread(pairId: string, quotes: QuoteResult[]): SpreadOpportunity | null {
  const valid = quotes.filter((q) => q && q.price > 0);

  if (valid.length < 2) {
    log.debug('Not enough valid quotes to compare', { pairId, count: valid.length });
    return null;
  }

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

  return best;
}

export function findAllSpreads(
  pairId: string,
  quotes: QuoteResult[],
  minSpreadBps: number
): SpreadOpportunity[] {
  const valid = quotes.filter((q) => q && q.price > 0);
  const results: SpreadOpportunity[] = [];

  for (let i = 0; i < valid.length; i++) {
    for (let j = 0; j < valid.length; j++) {
      if (i === j) continue;

      const buyQuote = valid[i];
      const sellQuote = valid[j];

      if (buyQuote.source === sellQuote.source) continue;

      const spreadBps = ((sellQuote.price - buyQuote.price) / buyQuote.price) * 10000;

      if (spreadBps >= minSpreadBps) {
        results.push({
          pairId,
          buySource: buyQuote.source,
          sellSource: sellQuote.source,
          buyQuote,
          sellQuote,
          spreadBps,
        });
      }
    }
  }

  return results.sort((a, b) => b.spreadBps - a.spreadBps);
}