import { ethers } from 'ethers';
import { enabledPairs, PairConfig } from '../config/pairs';
import { TokenInfo } from '../config/tokens';
// Uniswap V3 removed — ParaSwap and OpenOcean aggregate its liquidity.
import { paraswapV5Source } from './sources/paraswapV5';
import { openOceanV2Source } from './sources/openOceanV2';
import { PriceSource, QuoteResult } from './priceSource';
import { findBestSpread } from './spreadCalculator';
import { evaluateOpportunity, EvaluatedOpportunity } from '../profitability/evaluator';
import { processOpportunityBatch } from '../execution/queue';
import { hasExecutionCapacity } from '../execution/concurrency';
import { evaluateCircuitBreaker, isBreakerTripped } from '../risk/circuitBreaker';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import { recordScanCycle } from '../utils/healthServer';

const log = createLogger('scanLoop');

// ParaSwap V5 + OpenOcean V2 are sufficient; they cover Uniswap V3 pools via aggregation.
const SOURCES: PriceSource[] = [paraswapV5Source, openOceanV2Source];

let cachedNativeUsdPrice = 0.5;

function toRawAmount(amountHuman: number, token: TokenInfo): string {
  return ethers.utils.parseUnits(amountHuman.toString(), token.decimals).toString();
}

async function getQuotesForPair(pair: PairConfig): Promise<QuoteResult[]> {
  const positionRaw = toRawAmount(pair.maxPositionUsd, pair.quote);

  const requests = SOURCES.map((source) =>
    source.getQuote({
      tokenIn: pair.quote,
      tokenOut: pair.base,
      amountIn: positionRaw,
    }).catch((err) => {
      log.debug('Source quote threw', { source: source.name, pairId: pair.id, error: String(err) });
      return null;
    })
  );

  const results = await Promise.all(requests);
  return results.filter((r): r is QuoteResult => r !== null);
}

async function scanPair(pair: PairConfig): Promise<EvaluatedOpportunity | null> {
  const quotes = await getQuotesForPair(pair);

  if (quotes.length < 2) {
    return null;
  }

  const spreadOpp = findBestSpread(pair.id, quotes);
  if (!spreadOpp) {
    return null;
  }

  const evaluated = await evaluateOpportunity(pair, spreadOpp, cachedNativeUsdPrice);
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

  const pairs = enabledPairs();
  const results = await Promise.all(pairs.map((pair) => scanPair(pair).catch((err) => {
    log.error('Pair scan failed', { pairId: pair.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  })));

  const evaluated = results.filter((r): r is EvaluatedOpportunity => r !== null);

  if (evaluated.length === 0) {
    return;
  }

  log.info('Scan cycle found opportunities', {
    total: evaluated.length,
    executable: evaluated.filter((e) => e.executable).length,
  });

  await processOpportunityBatch(evaluated);
}

let loopHandle: NodeJS.Timeout | null = null;

export function startScanLoop(): void {
  if (loopHandle) return;

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