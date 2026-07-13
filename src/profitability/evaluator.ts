import { SpreadOpportunity } from '../scanner/spreadCalculator';
import { PairConfig } from '../config/pairs';
import { estimateFullCost } from './feeModel';
import { checkThresholds, ThresholdCheck } from './thresholds';
import { assessSlippage, meetsLiquidityFloor } from '../scanner/liquidityCheck';
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
 * Sanity check: reject spreads that are obviously impossible (too large).
 * A 100% spread = 10,000 bps is impossible in liquid markets.
 * Reject anything above 1,000 bps (10%) as likely a decimal error.
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

  // 🔴 Sanity check: reject impossible spreads
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
    // Return a non-executable opportunity
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

  let slippageOk = true;
  let slippageReason = 'no slippage check';
  if (options?.buyRequiresRequote || options?.sellRequiresRequote) {
    slippageOk = true;
    slippageReason = 'skipped (will re-quote)';
  } else {
    if (spreadOpp.buyQuote && spreadOpp.sellQuote) {
      const buyAssessment = assessSlippage(
        spreadOpp.buyQuote,
        spreadOpp.buyQuote,
        env.MAX_SLIPPAGE_BPS
      );
      const sellAssessment = assessSlippage(
        spreadOpp.sellQuote,
        spreadOpp.sellQuote,
        env.MAX_SLIPPAGE_BPS
      );
      slippageOk = buyAssessment.sufficient && sellAssessment.sufficient;
      if (!slippageOk) {
        slippageReason = `buy=${buyAssessment.estSlippageBps.toFixed(1)} bps, sell=${sellAssessment.estSlippageBps.toFixed(1)} bps (max=${env.MAX_SLIPPAGE_BPS} bps)`;
      }
    }
  }

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
    if (!slippageOk) {
      reasons.push(`slippage: ${slippageReason}`);
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