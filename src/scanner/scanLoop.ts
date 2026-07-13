import { ethers } from 'ethers';
import { enabledPairs, PairConfig } from '../config/pairs';
import { TokenInfo } from '../config/tokens';
import { paraswapV5Source } from './sources/paraswapV5';
import { oneInchV5Source } from './sources/oneInchV5';
// OpenOcean V2 removed (not supported on Polygon for execution)
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

// ParaSwap V5 + 1inch V5 for price discovery.
// 1inch offers superior liquidity aggregation on Polygon.
const SOURCES: PriceSource[] = [paraswapV5Source, oneInchV5Source];

let cachedNativeUsdPrice = 0.5;

function toRawAmount(amountHuman: number, token: TokenInfo): string {
  return ethers.utils.parseUnits(amountHuman.toString(), token.decimals).toString();
}

async function getQuotesForPair(pair: PairConfig): Promise<QuoteResult[]> {
  const positionRaw = toRawAmount(pair.maxPositionUsd, pair.quote);
  log.debug(`Getting quotes for ${pair.id}`);

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
  const valid = results.filter((r): r is QuoteResult => r !== null);
  log.debug(`Got ${valid.length} valid quotes for ${pair.id}`);
  return valid;
}

async function scanPair(pair: PairConfig): Promise<EvaluatedOpportunity | null> {
  const quotes = await getQuotesForPair(pair);

  if (quotes.length < 2) {
    log.debug(`Not enough quotes for ${pair.id} (got ${quotes.length})`);
    return null;
  }

  const spreadOpp = findBestSpread(pair.id, quotes);
  if (!spreadOpp) {
    log.debug(`No spread found for ${pair.id}`);
    return null;
  }

  log.debug(`Found spread for ${pair.id}: ${spreadOpp.spreadBps.toFixed(2)} bps`);
  const evaluated = await evaluateOpportunity(pair, spreadOpp, cachedNativeUsdPrice);
  return evaluated;
}

async function runScanCycle(): Promise<void> {
  log.info('🔄 Scan cycle started');
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
  log.info(`Evaluating ${pairs.length} enabled pairs`);

  const results = await Promise.all(pairs.map((pair) => scanPair(pair).catch((err) => {
    log.error('Pair scan failed', { pairId: pair.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  })));

  const evaluated = results.filter((r): r is EvaluatedOpportunity => r !== null);
  const executable = evaluated.filter((e) => e.executable);

  log.info(`🔄 Scan cycle complete: ${evaluated.length} evaluated, ${executable.length} executable`);

  if (executable.length === 0) {
    log.debug('No executable opportunities this cycle');
    return;
  }

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