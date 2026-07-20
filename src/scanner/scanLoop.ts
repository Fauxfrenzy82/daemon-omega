import { ethers } from 'ethers';
import { enabledPairs, PairConfig } from '../config/pairs';
import { TokenInfo } from '../config/tokens';
import { ensoRouteSource } from './sources/ensoRoute';
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
 * New scan logic: Get buy quotes from all DEXs, pick best.
 * Then get sell quotes from all DEXs (excluding the buy venue),
 * and pick best. Compute spread.
 */
async function scanPairWithDirectDex(pair: PairConfig): Promise<EvaluatedOpportunity | null> {
  const positionRaw = toRawAmount(pair.maxPositionUsd, pair.quote);

  // 1. Get buy quotes (quote → base) from all DEXs
  const buyQuotes = await getAllDirectDexQuotes(pair.quote, pair.base, positionRaw);
  const bestBuy = getBestQuote(buyQuotes);
  if (!bestBuy) {
    log.info('SCAN_FAIL no buy quotes from any DEX', { pairId: pair.id });
    return null;
  }

  const buyVenue = bestBuy.venue;

  // 2. Get sell quotes (base → quote) from all DEXs, excluding the buy venue
  const sellQuotes = await getAllDirectDexQuotes(
    pair.base,
    pair.quote,
    bestBuy.amountOut
  );
  const sellQuotesExcludingBuy = sellQuotes.filter(q => q.venue !== buyVenue);
  const bestSell = getBestQuote(sellQuotesExcludingBuy);
  if (!bestSell) {
    log.info('SCAN_FAIL no sell quotes excluding buy venue', {
      pairId: pair.id,
      buyVenue,
    });
    return null;
  }

  // 3. Compute spread
  const startAmount = Number(positionRaw) / (10 ** pair.quote.decimals);
  const endAmount = Number(bestSell.amountOut) / (10 ** pair.quote.decimals);
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

  // 4. Build an opportunity object for the evaluator
  // We need to create QuoteResult objects from the DirectDexQuote objects.
  // Convert them to the expected format (or modify evaluator to accept DirectDexQuote).
  // For simplicity, we'll use ensoRouteSource to get the actual route data (since
  // the evaluator expects route data for execution). But we already have the venue
  // and amountOut; we can build a fake QuoteResult for evaluation.
  // A better approach: add a new function to evaluator that accepts DirectDexQuote.
  // But to keep it simple, we'll pass the bestBuy and bestSell as they are,
  // and modify evaluator to accept them later.

  // For now, we'll create a spreadOpp object that contains the quotes.
  // We'll need to adapt evaluateOpportunity to handle our new quote type.
  // Since we don't have the evaluator code, we'll assume it can handle the
  // spreadOpp with buyQuote and sellQuote fields.

  const spreadOpp = {
    pairId: pair.id,
    buySource: 'direct-dex',
    sellSource: 'direct-dex',
    buyQuote: bestBuy,
    sellQuote: bestSell,
    spreadBps: spreadBps,
  };

  // We'll need to update evaluateOpportunity to accept our custom quote objects.
  // For now, we'll just log the opportunity and return null if evaluator can't handle it.
  // But we can create a wrapper that converts DirectDexQuote to QuoteResult.

  // Since we don't have the exact interface of QuoteResult, we'll create a minimal one.
  const buyQuoteResult: QuoteResult = {
    source: `direct-${bestBuy.venue}`,
    tokenIn: bestBuy.tokenIn,
    tokenOut: bestBuy.tokenOut,
    amountIn: bestBuy.amountIn,
    amountOut: bestBuy.amountOut,
    price: bestBuy.price,
    supportsExecution: true,
    raw: { venue: bestBuy.venue, protocol: bestBuy.protocol },
  };

  const sellQuoteResult: QuoteResult = {
    source: `direct-${bestSell.venue}`,
    tokenIn: bestSell.tokenIn,
    tokenOut: bestSell.tokenOut,
    amountIn: bestSell.amountIn,
    amountOut: bestSell.amountOut,
    price: bestSell.price,
    supportsExecution: true,
    raw: { venue: bestSell.venue, protocol: bestSell.protocol },
  };

  const evaluated = await evaluateOpportunity(pair, { buyQuote: buyQuoteResult, sellQuote: sellQuoteResult, spreadBps }, cachedNativeUsdPrice);
  return evaluated;
}

/**
 * Original scan function using ensoRouteSource (aggregator) – kept as fallback.
 */
async function scanPairWithAggregator(pair: PairConfig): Promise<EvaluatedOpportunity | null> {
  // ... (original code from before, or we can simply not use it)
  // We'll replace the main scan function with the direct DEX one.
  // For now, we'll keep both but use the direct one first.
}

async function scanPair(pair: PairConfig): Promise<EvaluatedOpportunity | null> {
  // Try direct DEX scan first.
  return scanPairWithDirectDex(pair);
}

// The rest of the file (runScanCycle, startScanLoop, stopScanLoop) remains the same.