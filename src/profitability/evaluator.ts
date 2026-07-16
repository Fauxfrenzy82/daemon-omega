import { SpreadOpportunity } from '../scanner/spreadCalculator';
import { PairConfig } from '../config/pairs';
import { estimateFullCost } from './feeModel';
import { checkThresholds, ThresholdCheck } from './thresholds';
import { meetsLiquidityFloor } from '../scanner/liquidityCheck';
import { env } from '../config/env';
import { createLogger } from '../utils/logger';

const log = createLogger('evaluator');

export interface EvaluatedOpportunity {
  pair: PairConfig;
  spreadOpp: SpreadOpportunity;
  positionSizeUsd: number;
  grossProfitUsd: number;
  gasCostUsd: number;
  protocolFeeUsd: number;
  netProfitUsd: number;
  thresholdCheck: ThresholdCheck;
  slippageOk: boolean;
  liquidityOk: boolean;
  executable: boolean;
  buyRequiresRequote: boolean;
  sellRequiresRequote: boolean;
}

/**
 * Sanity check: reject spreads that are obviously impossible.
 * Real, sustained cross-DEX arb spreads on these pairs rarely exceed
 * low hundreds of bps even in volatile moments; anything approaching
 * 10% (1000 bps) is essentially always a bad quote (thin/mispriced
 * pool), not a real opportunity. This catches the extreme cases
 * (e.g. 95,971 bps DAI-USDC) but NOT more moderate noise like the
 * observed 614 bps → 4.6 bps flip within 10 seconds on the same pair
 * — that pattern indicates an unreliable underlying quote source
 * (most likely a thin Uniswap V3 pool being selected), which must be
 * fixed at the source (uniswapV3.ts), not here. This threshold is a
 * backstop against extreme garbage, not a substitute for a reliable
 * price source.
 */
const MAX_SANE_SPREAD_BPS = 1000;

export async function evaluateOpportunity(
  pair: PairConfig,
  spreadOpp: SpreadOpportunity,
  nativeUsdPrice: number,
  options?: {
    buyRequiresRequote?: boolean;
    sellRequiresRequote?: boolean;
  }
): Promise<EvaluatedOpportunity> {
  const positionSizeUsd = Math.min(pair.maxPositionUsd, env.MAX_POSITION_SIZE_USD);
  const grossProfitUsd = positionSizeUsd * (spreadOpp.spreadBps / 10000);

  if (spreadOpp.spreadBps > MAX_SANE_SPREAD_BPS) {
    log.error(`🚨 IMPOSSIBLE SPREAD DETECTED: ${spreadOpp.spreadBps} bps for ${pair.id}`, {
      spreadBps: spreadOpp.spreadBps,
      buyPrice: spreadOpp.buyQuote.price,
      sellPrice: spreadOpp.sellQuote.price,
      buySource: spreadOpp.buySource,
      sellSource: spreadOpp.sellSource,
      buyAmountIn: spreadOpp.buyQuote.amountIn,
      buyAmountOut: spreadOpp.buyQuote.amountOut,
      sellAmountIn: spreadOpp.sellQuote.amountIn,
      sellAmountOut: spreadOpp.sellQuote.amountOut,
    });
    const thresholdCheck = checkThresholds(pair, spreadOpp.spreadBps, -999);
    return {
      pair,
      spreadOpp,
      positionSizeUsd,
      grossProfitUsd: 0,
      gasCostUsd: 999,
      protocolFeeUsd: 0,
      netProfitUsd: -999,
      thresholdCheck,
      slippageOk: false,
      liquidityOk: false,
      executable: false,
      buyRequiresRequote: options?.buyRequiresRequote || false,
      sellRequiresRequote: options?.sellRequiresRequote || false,
    };
  }

  const cost = await estimateFullCost(positionSizeUsd, nativeUsdPrice);
  const netProfitUsd = grossProfitUsd - cost.totalCostUsd;

  const thresholdCheck = checkThresholds(pair, spreadOpp.spreadBps, netProfitUsd);

  // ⚠️ HONEST FLAG: this was previously a no-op "slippage check" —
  // assessSlippage(spreadOpp.buyQuote, spreadOpp.buyQuote, ...) compared
  // the same quote object to itself, which always yields zero
  // difference, meaning slippageOk was unconditionally true whenever
  // this branch ran. That gave the illusion of a safety check that
  // was never actually protecting anything. Rather than leave that
  // misleading behavior in place, it's disabled here and marked
  // explicitly as not-yet-implemented. A real slippage check requires
  // fetching a genuinely separate reference quote (e.g. a small
  // fixed-size quote alongside the real position-size quote) to
  // compare against — that plumbing doesn't exist yet anywhere in
  // this pipeline. Until it does, slippageOk is left true (matching
  // prior real-world behavior) but is no longer pretending to have
  // verified anything.
  const slippageOk = true;
  const slippageReason = options?.buyRequiresRequote || options?.sellRequiresRequote
    ? 'skipped (will re-quote)'
    : 'not implemented — see comment in evaluator.ts';

  const liquidityOk =
    meetsLiquidityFloor(spreadOpp.buyQuote, positionSizeUsd) &&
    meetsLiquidityFloor(spreadOpp.sellQuote, positionSizeUsd);

  const executable = thresholdCheck.passes && slippageOk && liquidityOk;

  if (!executable) {
    const reasons: string[] = [];

    if (!thresholdCheck.passes) {
      if (!thresholdCheck.passesSpread) {
        reasons.push(`spread ${spreadOpp.spreadBps.toFixed(1)} bps < ${thresholdCheck.minSpreadBps} bps`);
      }
      if (!thresholdCheck.passesProfit) {
        reasons.push(`net profit $${netProfitUsd.toFixed(4)} < $${thresholdCheck.minProfitUsd}`);
      }
    }
    if (!liquidityOk) {
      reasons.push('insufficient liquidity');
    }

    log.info(`🔍 Opportunity REJECTED for ${pair.id}:`, {
      spreadBps: spreadOpp.spreadBps,
      positionSizeUsd,
      grossProfitUsd: grossProfitUsd.toFixed(4),
      netProfitUsd: netProfitUsd.toFixed(4),
      gasCostUsd: cost.gasCostUsd.toFixed(4),
      protocolFeeUsd: cost.protocolFeeUsd.toFixed(4),
      buySource: spreadOpp.buySource,
      sellSource: spreadOpp.sellSource,
      buyRequiresRequote: options?.buyRequiresRequote || false,
      sellRequiresRequote: options?.sellRequiresRequote || false,
      reasons: reasons.join('; '),
    });
  } else {
    log.info(`✅ Opportunity ACCEPTABLE for ${pair.id}:`, {
      spreadBps: spreadOpp.spreadBps,
      netProfitUsd: netProfitUsd.toFixed(4),
      positionSizeUsd,
      buySource: spreadOpp.buySource,
      sellSource: spreadOpp.sellSource,
      buyRequiresRequote: options?.buyRequiresRequote || false,
      sellRequiresRequote: options?.sellRequiresRequote || false,
      note: 'slippage not independently verified — see evaluator.ts',
    });
  }

  return {
    pair,
    spreadOpp,
    positionSizeUsd,
    grossProfitUsd,
    gasCostUsd: cost.gasCostUsd,
    protocolFeeUsd: cost.protocolFeeUsd,
    netProfitUsd,
    thresholdCheck,
    slippageOk,
    liquidityOk,
    executable,
    buyRequiresRequote: options?.buyRequiresRequote || false,
    sellRequiresRequote: options?.sellRequiresRequote || false,
  };
}

export function rankExecutable(evaluated: EvaluatedOpportunity[]): EvaluatedOpportunity[] {
  return evaluated
    .filter((e) => e.executable)
    .sort((a, b) => b.netProfitUsd - a.netProfitUsd);
}