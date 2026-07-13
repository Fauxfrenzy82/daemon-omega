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
}

export async function evaluateOpportunity(
  pair: PairConfig,
  spreadOpp: SpreadOpportunity,
  nativeUsdPrice: number,
  smallSizeQuoteForSlippage?: { buy?: any; sell?: any }
): Promise<EvaluatedOpportunity> {
  const positionSizeUsd = Math.min(pair.maxPositionUsd, env.MAX_POSITION_SIZE_USD);
  const grossProfitUsd = positionSizeUsd * (spreadOpp.spreadBps / 10000);

  const cost = await estimateFullCost(positionSizeUsd, nativeUsdPrice);
  const netProfitUsd = grossProfitUsd - cost.totalCostUsd;

  const thresholdCheck = checkThresholds(pair, spreadOpp.spreadBps, netProfitUsd);

  let slippageOk = true;
  let slippageReason = 'no slippage check';
  if (smallSizeQuoteForSlippage?.buy && smallSizeQuoteForSlippage?.sell) {
    const buyAssessment = assessSlippage(
      smallSizeQuoteForSlippage.buy,
      spreadOpp.buyQuote,
      env.MAX_SLIPPAGE_BPS
    );
    const sellAssessment = assessSlippage(
      smallSizeQuoteForSlippage.sell,
      spreadOpp.sellQuote,
      env.MAX_SLIPPAGE_BPS
    );
    slippageOk = buyAssessment.sufficient && sellAssessment.sufficient;
    if (!slippageOk) {
      slippageReason = `buy=${buyAssessment.estSlippageBps.toFixed(1)} bps, sell=${sellAssessment.estSlippageBps.toFixed(1)} bps (max=${env.MAX_SLIPPAGE_BPS} bps)`;
    }
  }

  const liquidityOk =
    meetsLiquidityFloor(spreadOpp.buyQuote, positionSizeUsd) &&
    meetsLiquidityFloor(spreadOpp.sellQuote, positionSizeUsd);

  const executable = thresholdCheck.passes && slippageOk && liquidityOk;

  // Detailed rejection logging — every pair gets logged
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
      reasons: reasons.join('; '),
    });
  } else {
    log.info(`✅ Opportunity ACCEPTABLE for ${pair.id}:`, {
      spreadBps: spreadOpp.spreadBps,
      netProfitUsd: netProfitUsd.toFixed(4),
      positionSizeUsd,
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
  };
}

export function rankExecutable(evaluated: EvaluatedOpportunity[]): EvaluatedOpportunity[] {
  return evaluated
    .filter((e) => e.executable)
    .sort((a, b) => b.netProfitUsd - a.netProfitUsd);
}