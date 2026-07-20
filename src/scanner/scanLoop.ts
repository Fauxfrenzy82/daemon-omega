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

const log = createLogger('scanLoop');

const SOURCES: PriceSource[] = [ensoRouteSource];

let cachedNativeUsdPrice = 0.5;

function toRawAmount(amountHuman: number, token: TokenInfo): string {
  if (amountHuman <= 0) {
    return '0';
  }
  return ethers.utils.parseUnits(amountHuman.toString(), token.decimals).toString();
}

/**
 * Sell-leg quote that excludes whichever protocol the buy leg actually
 * used. This is a real, narrower arbitrage question genuinely
 * different from the plain round-trip test: "given I bought via
 * venue X, is there somewhere ELSE that pays more to sell back,
 * rather than routing back through the same place." Uses the exact
 * same getRouteData call shape as ensoRoute.ts (already proven to
 * execute without error for weeks) plus one extra, already-documented
 * field (ignoreStandards) — no new, unverified per-protocol
 * parameters like poolFee/tickSpacing/primaryAddress that have
 * repeatedly required fresh guessing this session.
 */
async function getSellQuoteExcludingVenue(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string,
  excludeProtocol: string | undefined
): Promise<QuoteResult | null> {
  try {
    const enso = getEnsoClient();
    const chainId = activeChain.chainId;
    const walletAddress = executionWallet.address as `0x${string}`;

    const routeData = await withRetry(
      () =>
        enso.getRouteData({
          fromAddress: walletAddress,
          receiver: walletAddress,
          spender: walletAddress,
          chainId,
          amountIn: [amountIn],
          tokenIn: [tokenIn.address as `0x${string}`],
          tokenOut: [tokenOut.address as `0x${string}`],
          slippage: '100',
          routingStrategy: 'router',
          ignoreStandards: excludeProtocol ? [excludeProtocol] : undefined,
        } as any),
      {
        label: `sellExcl.${tokenIn.symbol}->${tokenOut.symbol}`,
        shouldRetry: isTransientError,
        retries: 1,
      }
    );

    const amountOut = (routeData as any)?.amountOut;
    if (!amountOut) {
      return null;
    }

    const amountInHuman = Number(amountIn) / 10 ** tokenIn.decimals;
    const amountOutHuman = Number(amountOut) / 10 ** tokenOut.decimals;
    const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

    return {
      source: 'enso-route-excl',
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: String(amountOut),
      price,
      supportsExecution: true,
      raw: routeData,
    };
  } catch (err: any) {
    log.debug('Sell-excl quote failed', {
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      excludeProtocol,
      error: err?.message || String(err),
    });
    return null;
  }
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

  const buyWinningProtocol = (buyQuote.raw as any)?.route?.[0]?.protocol as string | undefined;

  const sellQuote = await getSellQuoteExcludingVenue(
    pair.base,
    pair.quote,
    buyQuote.amountOut,
    buyWinningProtocol
  );

  if (!sellQuote) {
    log.info('SCAN_FAIL sell-leg quote failed (excluding buy venue)', {
      pairId: pair.id,
      tokenIn: pair.base.symbol,
      tokenOut: pair.quote.symbol,
      excludedProtocol: buyWinningProtocol,
    });
    return null;
  }

  const startAmount = Number(positionRaw) / (10 ** pair.quote.decimals);
  const endAmount = Number(sellQuote.amountOut) / (10 ** pair.quote.decimals);
  const spreadBps = ((endAmount - startAmount) / startAmount) * 10000;

  if (endAmount <= startAmount) {
    log.info('SCAN_LOSS round trip unprofitable (sell excl. buy venue)', {
      pairId: pair.id,
      excludedProtocol: buyWinningProtocol,
      startAmount: startAmount.toFixed(4),
      endAmount: endAmount.toFixed(4),
      spreadBps: spreadBps.toFixed(2),
    });
    return null;
  }

  log.info('SCAN_GAIN round trip positive (sell excl. buy venue)', {
    pairId: pair.id,
    excludedProtocol: buyWinningProtocol,
    startAmount: startAmount.toFixed(4),
    endAmount: endAmount.toFixed(4),
    spreadBps: spreadBps.toFixed(2),
  });

  const spreadOpp = {
    pairId: pair.id,
    buySource: 'enso-route',
    sellSource: 'enso-route-excl',
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