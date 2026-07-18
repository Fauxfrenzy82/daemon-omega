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

const SOURCES: PriceSource[] = [
  ensoRouteSource,
];

let cachedNativeUsdPrice = 0.5;

function toRawAmount(amountHuman: number, token: TokenInfo): string {
  if (amountHuman <= 0) return '0';
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
    log.info(`⛔ ${pair.id}: buy-leg quote failed (quote->base)`, {
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
    log.info(`⛔ ${pair.id}: sell-leg quote failed (base->quote)`, {
      tokenIn: pair.base.symbol,
      tokenOut: pair.quote.symbol,
      buyAmountOut: buyQuote.amountOut,
    });
    return null;
  }

  const startAmount = Number(positionRaw) / 10 ** pair.quote.decimals;
  const endAmount = Number(sellQuote.amountOut) / 10 ** pair.quote.decimals;
  const spreadBps = ((endAmount - startAmount) / startAmount) * 10000;

  if (endAmount <= startAmount) {
    log.info(`📉 ${pair.id}: round trip unprofitable before fees`, {
      startAmount: startAmount.toFixed(4),
      endAmount: endAmount.toFixed(4),
      spreadBps: spreadBps.toFixed(2),
    });
    return null;
  }

  log.info(`📈 ${pair.id}: round trip positive before fees`, {
    startAmount: startAmount.toFixed(4),
    endAmount: endAmount.toFixed(4),
    spreadBps: spreadBps.toFixed(2),
  });

  const spreadOpp = {
    pairId: pair.id,
    buySource: 'enso-route',
    sellSource: 'enso-route',
    buyQuote,
    sellQuote,
    spreadBps,
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

  log.info('🔄 Scan cycle started');

  const pairs = enabledPairs();
  log.info(`Evaluating ${pairs.length} enabled pairs`);

  const results = await Promise.all(pairs.map((pair) => scanPair(pair).catch((err) => {
    log.error('Pair scan failed', { pairId: pair.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  })));

  const evaluated = results.filter((r): r is EvaluatedOpportunity => r !== null);

  log.info(`🔄 Scan cycle complete: ${evaluated.length} evaluated, ${evaluated.filter((e) => e.executable).length} executable`);

  if (evaluated.length === 0) {
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
      log.err