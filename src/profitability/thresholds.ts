import { PairConfig } from '../config/pairs';
import { env } from '../config/env';

export interface ThresholdCheck {
  passesSpread: boolean;
  passesProfit: boolean;
  passes: boolean;
  minSpreadBps: number;
  minProfitUsd: number;
}

export function getThresholdsForPair(pair: PairConfig): { minSpreadBps: number; minProfitUsd: number } {
  return {
    minSpreadBps: pair.minSpreadBps ?? env.DEFAULT_MIN_SPREAD_BPS,
    minProfitUsd: pair.minProfitUsd ?? env.DEFAULT_MIN_PROFIT_USD,
  };
}

export function checkThresholds(
  pair: PairConfig,
  spreadBps: number,
  netProfitUsd: number
): ThresholdCheck {
  const { minSpreadBps, minProfitUsd } = getThresholdsForPair(pair);

  const passesSpread = spreadBps >= minSpreadBps;
  const passesProfit = netProfitUsd >= minProfitUsd;

  return {
    passesSpread,
    passesProfit,
    passes: passesSpread && passesProfit,
    minSpreadBps,
    minProfitUsd,
  };
}