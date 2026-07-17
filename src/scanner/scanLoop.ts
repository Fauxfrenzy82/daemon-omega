import { ethers } from 'ethers';
import { enabledPairs, PairConfig } from '../config/pairs';
import { TokenInfo } from '../config/tokens';
import { ensoRouteSource } from './sources/ensoRoute';
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

// paraswapV5Source and uniswapV3Source REMOVED, replaced with
// ensoRouteSource. Root cause: those two sources priced trades using
// independent systems (Uniswap V3's direct on-chain quoter + Velora/
// ParaSwap's separate price API) that routinely disagreed with what
// Enso's own execution engine actually delivered — by 100+ bps in
// production, on the same pair, same moment (scanner said +67 bps
// profit, Enso's real execution came back -84 bps short). Since Enso
// is what actually executes every trade, pricing with Enso's own
// /shortcuts/route endpoint (same routing engine) closes that gap by
// construction. This also removes the ParaSwap dependency entirely,
// which has separately begun hard rate-limiting (429s on every
// request) as of this session — a second, independent problem this
// same change resolves.
//
// NOTE: findBestSpread() requires at least 2 quotes per pair to
// compute a spread — with a single source, that comparison no longer
// applies the same way. See scanPair() below for the adjusted logic.
const SOURCES: PriceSource[] = [
  ensoRouteSource,
];

let cachedNativeUsdPrice = 0.5;

function toRawAmount(amountHuman: number, token: TokenInfo): string {
  if (amountHuman <= 0) return '0';
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

/**
 * With a single price source (Enso route), there is no cross-source
 * spread to compute in the old sense — Enso's quote IS the real,
 * executable price. Instead of comparing two sources' prices against
 * each other, this fetches the buy-leg quote (quote->base) and the
 * sell-leg quote (base->quote) from Enso separately, and treats a
 * round-trip that returns MORE than it started with (accounting for
 * fees) as the opportunity signal — this is the actual, real
 * arbitrage condition (buy low here, sell high there, within Enso's
 * own aggregated liquidity across many DEXs), rather than a
 * synthetic cross-source spread that never matched execution reality.
 */
async function scanPair(pair: PairConfig): Promise<EvaluatedOpportunity | null> {
  const positionRaw = toRawAmount(pair.maxPositionUsd, pair.quote);

  const buyQuote = await ensoRouteSource.getQuote({
    tokenIn: pair.quote,
    tokenOut: pair.base,
    amountIn: positionRaw,
  });

  if (!buyQuote) {
    return null;
  }

  const sellQuote = await ensoRouteSource.getQuote({
    tokenIn: pair.base,
    tokenOut: pair.quote,
    amountIn: buyQuote.amountOut,
  });

  if (!sellQuote) {
    return null;
  }

  const startAmount = Number(positionRaw) / 10 ** pair.quote.decimals;
  const endAmount = Number(sellQuote.amountOut) / 10 ** pair.quote.decimals;

  if (endAmount <= startAmount) {
    return null; // round trip loses money before any fee/gas is even considered
  }

  const spreadBps = ((endAmount - startAmount) / startAmount) * 10000;

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