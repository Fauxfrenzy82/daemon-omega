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
  DirectDexQuote,
} from './sources/directDexSource';
import { ensoRouteSource } from './sources/ensoRoute';

const log = createLogger('scanLoop');

let cachedNativeUsdPrice = 0.5;

const INTER_PAIR_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toRawAmount(amountHuman: number, token: TokenInfo): string {
  if (amountHuman <= 0) return '0';
  return ethers.utils.parseUnits(amountHuman.toString(), token.decimals).toString();
}

function toQuoteResult(quote: DirectDexQuote, source: string): QuoteResult {
  return {
    source,
    tokenIn: quote.tokenIn,
    tokenOut: quote.tokenOut,
    amountIn: quote.amountIn,
    amountOut: quote.amountOut,
    price: quote.price,
    supportsExecution: true,
    raw: quote.raw,
  };
}

/**
 * Ask Enso's own /shortcuts/route endpoint for its best route, and wrap
 * it as a DirectDexQuote (venue: 'enso-route') so it can compete
 * directly against the per-DEX quotes in the same round-trip search.
 * This is a TEST of whether Enso's own routing already finds liquidity
 * (e.g. sushiswap-v3, or others) that we have no verified router
 * address for — no primaryAddress needed, Enso picks the path itself.
 * priceImpactBps is null here since /shortcuts/route doesn't return it
 * the way the Bundle API does — this quote is NOT filtered by
 * MAX_PRICE_IMPACT_BPS as a result, so treat any spread it produces
 * with extra scrutiny until we understand its liquidity characteristics.
 */
async function getEnsoRouteQuote(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string
): Promise<DirectDexQuote | null> {
  const result = await ensoRouteSource.getQuote({ tokenIn, tokenOut, amountIn });
  if (!result) return null;

  return {
    venue: 'enso-route',
    tokenIn: result.tokenIn,
    tokenOut: result.tokenOut,
    amountIn: result.amountIn,
    amountOut: result.amountOut,
    price: result.price,
    priceImpactBps: null,
    raw: result.raw,
  };
}

interface RoundTrip {
  buyQuote: DirectDexQuote;
  sellQuote: DirectDexQuote;
  endAmount: number;
}

function findBestRoundTrip(
  buyQuotes: DirectDexQuote[],
  sellQuotesByBuyVenue: Map<string, DirectDexQuote[]>,
  quoteDecimals: number
): RoundTrip | null {
  let best: RoundTrip | null = null;

  for (const buyQuote of buyQuotes) {
    const sellQuotes = sellQuotesByBuyVenue.get(buyQuote.venue) ?? [];
    for (const sellQuote of sellQuotes) {
      if (sellQuote.venue === buyQuote.venue) continue;

      const endAmount = Number(sellQuote.amountOut) / 10 ** quoteDecimals;
      if (!best || endAmount > best.endAmount) {
        best = { buyQuote, sellQuote, endAmount };
      }
    }
  }

  return best;
}

async function scanPair(pair: PairConfig): Promise<EvaluatedOpportunity | null> {
  const positionRaw = toRawAmount(pair.maxPositionUsd, pair.quote);

  // 1. Buy quotes: existing direct-DEX venues PLUS Enso's own route finder.
  const directBuyQuotes = await getAllDirectDexQuotes(pair.quote, pair.base, positionRaw);
  const ensoRouteBuy = await getEnsoRouteQuote(pair.quote, pair.base, positionRaw);
  const buyQuotes = ensoRouteBuy ? [...directBuyQuotes, ensoRouteBuy] : directBuyQuotes;

  if (buyQuotes.length === 0) {
    log.info('SCAN_FAIL no buy quotes from any DEX', { pairId: pair.id });
    return null;
  }

  // 2. For each buy venue's resulting amount, fetch sell quotes from every
  //    OTHER direct venue, plus Enso's route finder for that same amount.
  const sellQuotesByBuyVenue = new Map<string, DirectDexQuote[]>();
  for (const buyQuote of buyQuotes) {
    const directSellQuotes = await getAllDirectDexQuotes(
      pair.base,
      pair.quote,
      buyQuote.amountOut,
      [buyQuote.venue]
    );
    const ensoRouteSell =
      buyQuote.venue === 'enso-route'
        ? null // avoid enso-route vs enso-route same-venue trip
        : await getEnsoRouteQuote(pair.base, pair.quote, buyQuote.amountOut);

    const sellQuotes = ensoRouteSell ? [...directSellQuotes, ensoRouteSell] : directSellQuotes;
    sellQuotesByBuyVenue.set(buyQuote.venue, sellQuotes);
  }

  // 3. Search every valid (buyVenue, sellVenue) combination.
  const bestTrip = findBestRoundTrip(buyQuotes, sellQuotesByBuyVenue, pair.quote.decimals);
  if (!bestTrip) {
    log.info('SCAN_FAIL no valid cross-venue sell quotes', { pairId: pair.id });
    return null;
  }

  const { buyQuote: bestBuy, sellQuote: bestSell } = bestTrip;

  const startAmount = Number(positionRaw) / 10 ** pair.quote.decimals;
  const endAmount = bestTrip.endAmount;
  const spreadBps = ((endAmount - startAmount) / startAmount) * 10000;

  if (endAmount <= startAmount) {
    log.info('SCAN_LOSS cross-venue (buy: %s, sell: %s)', {
      pairId: pair.id,
      buyVenue: bestBuy.venue,
      sellVenue: bestSell.venue,
      startAmount: startAmount.toFixed(4),
      endAmount: endAmount.toFixed(4),
      spreadBps: spreadBps.toFixed(2),
    });
    return null;
  }

  log.info('SCAN_GAIN cross-venue (buy: %s, sell: %s)', {
    pairId: pair.id,
    buyVenue: bestBuy.venue,
    sellVenue: bestSell.venue,
    startAmount: startAmount.toFixed(4),
    endAmount: endAmount.toFixed(4),
    spreadBps: spreadBps.toFixed(2),
  });

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

  const evaluated = await evaluateOpportunity(
    pair,
    spreadOpp,
    cachedNativeUsdPrice,
    {
      buyRequiresRequote: bestBuy.venue === 'enso-route',
      sellRequiresRequote: bestSell.venue === 'enso-route',
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

  const evaluated: EvaluatedOpportunity[] = [];
  for (const pair of pairs) {
    try {
      const result = await scanPair(pair);
      if (result) {
        evaluated.push(result);
      }
    } catch (err) {
      log.error('Pair scan failed', {
        pairId: pair.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(INTER_PAIR_DELAY_MS);
  }

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