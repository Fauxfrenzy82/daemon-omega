import { ethers } from 'ethers';
import { enabledPairs, PairConfig } from '../config/pairs';
import { TokenInfo } from '../config/tokens';
import { ensoRouteSource } from './sources/ensoRoute';
import { PriceSource, QuoteResult } from './priceSource';
import { evaluateOpportunity, EvaluatedOpportunity } from '../profitability/evaluator';
import { processOpportunityBatch } from '../execution/queue';
import { hasExecutionCapacity } from '../execution/concurrency';
import { evaluateCircuitBreaker, isBreakerTripped } from '../risk/circuitBreaker';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import { recordScanCycle } from '../utils/healthServer';

const log = createLogger('scanLoop');

const SOURCES: PriceSource[] = [ensoRouteSource];

let cachedNativeUsdPrice = 0.5;

function toRawAmount(amountHuman: number, token: TokenInfo): string {
  if (amountHuman <= 0) {
    return '0';
  }
  return ethers.utils.parseUnits(amountHuman.toString(), token.decimals).toString();
}

async function scanPair(pair: PairConfig): Promise<EvaluatedOpportunity | null> {
  const positionRaw = toRawAmount(pair.maxPositionUsd, pair.quote);

  const buyQuote = await ensoRouteSource.getQuote({
    tokenIn: pair.quote,
    tokenOut: pair.base,
    amountIn: positionRaw,
  });

  if (!buyQuote) {
    log.info('SCAN_FAIL buy-leg quote failed', {
      pairId: pair.id,
      tokenIn: pair.quote.symbol,
      tokenOut: pair.base.symbol,
    });
    return null;
  }

  const sellQuote = await ensoRouteSource.getQuote({
    tokenIn: pair.base,
    tokenOut: pair.quote,
    amountIn: buyQuote.amountOut,
  });

  if (!sellQuote) {
    log.info('SCAN_FAIL sell-leg quote failed', {
      pairId: pair.id,
      tokenIn: pair.base.symbol,
      tokenOut: pair.quote.symbol,
      buyAmountOut: buyQuote.amountOut,
    });
    return null;
  }

  const startAmount = Number(positionRaw) / (10 ** pair.quote.decimals);
  const endAmount = Number(sellQuote.amountOut) / (10 ** pair.quote.decimals);
  const spreadBps = ((endAmount - startAmount) / startAmount) * 10000;

  if (endAmount <= startAmount) {
    log.info('SCAN_LOSS round trip unprofitable before fees', {
      pairId: pair.id,
      startAmount: startAmount.toFixed(4),
      endAmount: endAmount.toFixed(4),
      spreadBps: spreadBps.toFixed(2),
    });
    return null;
  }

  log.info('SCAN_GAIN round trip positive before fees', {
    pairId: pair.id,
    startAmount: startAmount.toFixed(4),
    endAmount: endAmount.toFixed(4),
    spreadBps: spreadBps.toFixed(2),
  });

  const spreadOpp = {
    pairId: pair.id,
    buySource: 'enso-route',
    sellSource: 'enso-route',
    buyQuote: buyQuote,
    sellQuote: sellQuote,
    spreadBps: spreadBps,
  };

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