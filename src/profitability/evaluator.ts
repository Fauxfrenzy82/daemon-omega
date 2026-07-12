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
  }

  const liquidityOk =
    meetsLiquidityFloor(spreadOpp.buyQuote, positionSizeUsd) &&
    meetsLiquidityFloor(spreadOpp.sellQuote, positionSizeUsd);

  const executable = thresholdCheck.passes && slippageOk && liquidityOk;

  // Detailed logging to see why a potential trade is not executable
  if (!executable) {
    log.debug('Opportunity rejected', {
      pairId: pair.id,
      spreadBps: spreadOpp.spreadBps,
      grossProfitUsd,
      netProfitUsd,
      gasCostUsd: cost.gasCostUsd,
      protocolFeeUsd: cost.protocolFeeUsd,
      thresholdPasses: thresholdCheck.passes,
      slippageOk,
      liquidityOk,
      threshold: thresholdCheck,
    });
  }

  const evaluated: EvaluatedOpportunity = {
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

  log.debug('Opportunity evaluated', {
    pairId: pair.id,
    spreadBps: spreadOpp.spreadBps,
    netProfitUsd,
    executable,
  });

  return evaluated;
}

export function rankExecutable(evaluated: EvaluatedOpportunity[]): EvaluatedOpportunity[] {
  return evaluated
    .filter((e) => e.executable)
    .sort((a, b) => b.netProfitUsd - a.netProfitUsd);
}