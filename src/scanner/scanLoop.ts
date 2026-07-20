import { ethers } from 'ethers';
import { enabledPairs, PairConfig } from '../config/pairs';
import { TokenInfo } from '../config/tokens';
import { getEnsoClient } from '../execution/ensoClient';
import { activeChain } from '../config/chains';
import { executionWallet } from '../treasury/wallets';
import { withRetry, isTransientError } from '../utils/retry';
import { PriceSource, QuoteResult } from './priceSource';
import { evaluateOpportunity, EvaluatedOpportunity } from '../profitability/evaluator';
import { processOpportunityBatch } from '../execution/queue';
import { hasExecutionCapacity } from '../execution/concurrency';
import { evaluateCircuitBreaker, isBreakerTripped } from '../risk/circuitBreaker';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import { recordScanCycle } from '../utils/healthServer';
import {
  getAllDirectDexQuotes,
  getBestQuote,
  DirectDexQuote,
} from './sources/directDexSource';

const log = createLogger('scanLoop');

let cachedNativeUsdPrice = 0.5;

function toRawAmount(amountHuman: number, token: TokenInfo): string {
  if (amountHuman <= 0) return '0';
  return ethers.utils.parseUnits(amountHuman.toString(), token.decimals).toString();
}

/**
 * Convert a DirectDexQuote to a QuoteResult for the evaluator.
 */
function toQuoteResult(quote: DirectDexQuote, source: string): QuoteResult {
  return {
    source,
    tokenIn: quote.tokenIn,
    tokenOut: quote.tokenOut,
    amountIn: quote.amountIn,
    amountOut: quote.amountOut,
    price: quote.price,
    supportsExecution: true,
    raw: {
      venue: quote.venue,
      protocol: quote.protocol,
      primaryAddress: quote.primaryAddress,
    },
  };
}

/**
 * Scan a single pair using direct DEX quotes (cross-venue).
 */
async function scanPair(pair: PairConfig): Promise<EvaluatedOpportunity | null> {
  const positionRaw = toRawAmount(pair.maxPositionUsd, pair.quote);

  // 1. Buy quotes (quote → base)
  const buyQuotes = await getAllDirectDexQuotes(pair.quote, pair.base, positionRaw);
  const bestBuy = getBestQuote(buyQuotes);
  if (!bestBuy) {
    log.info('SCAN_FAIL no buy quotes from any DEX', { pairId: pair.id });
    return null;
  }
  const buyVenue = bestBuy.venue;

  // 2. Sell quotes (base → quote), excluding buy venue
  const sellQuotes = await getAllDirectDexQuotes(
    pair.base,
    pair.quote,
    bestBuy.amountOut
  );
  const sellQuotesExcludingBuy = sellQuotes.filter((q) => q.venue !== buyVenue);
  const bestSell = getBestQuote(sellQuotesExcludingBuy);
  if (!bestSell) {
    log.info('SCAN_FAIL no sell quotes excluding buy venue', {
      pairId: pair.id,
      buyVenue,
    });
    return null;
  }

  // 3. Compute spread
  const startAmount = Number(positionRaw) / 10 ** pair.quote.decimals;
  const endAmount = Number(bestSell.amountOut) / 10 ** pair.quote.decimals;
  const spreadBps = ((endAmount - startAmount) / startAmount) * 10000;

  if (endAmount <= startAmount) {
    log.info('SCAN_LOSS cross-venue (buy: %s, sell: %s)', {
      pairId: pair.id,
      buyVenue,
      sellVenue: bestSell.venue,
      startAmount: startAmount.toFixed(4),
      endAmount: endAmount.toFixed(4),
      spreadBps: spreadBps.toFixed(2),
    });
    return null;
  }

  log.info('SCAN_GAIN cross-venue (buy: %s, sell: %s)', {
    pairId: pair.id,
    buyVenue,
    sellVenue: bestSell.venue,
    startAmount: startAmount.toFixed(4),
    endAmount: endAmount.toFixed(4),
    spreadBps: spreadBps.toFixed(2),
  });

  // 4. Build SpreadOpportunity for evaluator
  const buyQuoteResult = toQuoteResult(bestBuy, `direct-${bestBuy.venue}`);
  const sellQuoteResult = toQuoteResult(bestSell, `direct-${bestSell.venue}`);

  const spreadOpp = {
    pairId: pair.id,
    buySource: buyQuoteResult.source,
    sellSource: sellQuoteResult.source,
    buyQuote: buyQuoteResult,
    sellQuote: sellQuoteResult,
    spreadBps,
  };

  // 5. Evaluate
  const evaluated = await evaluateOpportunity(
    pair,
    spreadOpp,
    cachedNativeUsdPrice,
    {
      buyRequiresRequote: false,
      sellRequiresRequote: false,
    }
  );

  return evaluated;
}

async function runScanCycle(): Promise<void> {
  recordScanCycle();

  await evaluateCircuitBreaker();

  if (isBreakerTripped()) {
    log.warn('Circuit breaker active, skipping scan cycle execution phase');
    return;
  }

  if (!hasExecutionCapacity()) {
    log.debug('At execution capacity, skipping this cycle');
    return;
  }

  log.info('Scan cycle started');

  const pairs = enabledPairs();
  log.info('Evaluating enabled pairs', { count: pairs.length });

  const results = await Promise.all(
    pairs.map((pair) => {
      return scanPair(pair).catch((err) => {
        log.error('Pair scan failed', {
          pairId: pair.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
    })
  );

  const evaluated = results.filter((r): r is EvaluatedOpportunity => r !== null);
  const executableCount = evaluated.filter((e) => e.executable).length;

  log.info('Scan cycle complete', {
    evaluatedCount: evaluated.length,
    executableCount: executableCount,
  });

  if (evaluated.length === 0) {
    return;
  }

  await processOpportunityBatch(evaluated);
}

let loopHandle: NodeJS.Timeout | null = null;

export function startScanLoop(): void {
  if (loopHandle) {
    return;
  }

  log.info('Starting scan loop', { intervalMs: env.SCAN_INTERVAL_MS });

  loopHandle = setInterval(() => {
    runScanCycle().catch((err) => {
      log.error('Scan cycle threw an unhandled error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, env.SCAN_INTERVAL_MS);
}

export function stopScanLoop(): void {
  if (loopHandle) {
    clearInterval(loopHandle);
    loopHandle = null;
    log.info('Scan loop stopped');
  }
}