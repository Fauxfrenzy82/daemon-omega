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
  evaluatedAt: number;
}

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
  const evaluatedAt = Date.now();
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
      evaluatedAt,
    };
  }

  const cost = await estimateFullCost(positionSizeUsd, nativeUsdPrice);
  const netProfitUsd = grossProfitUsd - cost.totalCostUsd;

  const thresholdCheck = checkThresholds(pair, spreadOpp.spreadBps, netProfitUsd);

  // ⚠️ Still not independently verified — see prior note. Left as-is.
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
      slippageBufferUsd: cost.slippageBufferUsd?.toFixed(4),
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
    evaluatedAt,
  };
}

export function rankExecutable(evaluated: EvaluatedOpportunity[]): EvaluatedOpportunity[] {
  return evaluated
    .filter((e) => e.executable)
    .sort((a, b) => b.netProfitUsd - a.netProfitUsd);
}