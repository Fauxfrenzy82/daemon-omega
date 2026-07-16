import { ethers } from 'ethers';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';

const log = createLogger('feeModel');

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);

export const ESTIMATED_GAS_UNITS = {
  flashloanArbitrage: 200000,
};

// Aave V3's flashloan fee is a flat 0.05% (5 bps) of the borrowed
// amount, confirmed directly from production logs: a $1000 DAI loan
// required 1000.5 DAI repaid (1000500000000000000000 /
// 1000000000000000000000 = 1.0005). This was previously hardcoded to
// 0 in estimateProtocolFeeUsd, meaning the evaluator never subtracted
// this real cost from any profitability calculation — every trade
// that reached execution was overestimating profit by at least this
// much before ever accounting for slippage.
const AAVE_FLASHLOAN_FEE_BPS = 5;

// Real round-trip slippage observed across both swap legs, beyond the
// flashloan fee alone: DAI shortfall was ~29.4 bps total, USDC ~14.5
// bps, WMATIC ~13.5 bps — subtracting the fixed 5 bps Aave fee leaves
// roughly 8.5–24 bps of genuine swap slippage/spread decay between
// the scanner's pre-trade quote and Enso's actual on-chain simulation.
// This buffer is deliberately set toward the higher end of what was
// observed (25 bps) as a safety margin, since slippage varies by pair
// and market conditions and this is meant to prevent trades reaching
// execution only to fail, not just to match the average case exactly.
const ESTIMATED_SLIPPAGE_BUFFER_BPS = 25;

export interface GasCostEstimate {
  gasPriceGwei: number;
  gasUnits: number;
  costNative: number;
  costUsd: number;
}

export async function estimateGasCostUsd(
  gasUnits: number,
  nativeUsdPrice: number
): Promise<GasCostEstimate> {
  const gasPrice = await withRetry(() => provider.getGasPrice(), {
    label: 'feeModel.getGasPrice',
    shouldRetry: isTransientError,
  });

  const gasPriceGwei = Number(ethers.utils.formatUnits(gasPrice, 'gwei'));
  const costNativeBn = gasPrice.mul(gasUnits);
  const costNative = Number(ethers.utils.formatEther(costNativeBn));
  const costUsd = costNative * nativeUsdPrice;

  return { gasPriceGwei, gasUnits, costNative, costUsd };
}

/**
 * Returns the Aave V3 flashloan fee in USD for a given notional
 * amount. Previously hardcoded to 0 — this was the direct cause of
 * trades passing the evaluator's profitability check only to fail at
 * Enso with "Flashloan repayment insufficient", since the fee was
 * never subtracted anywhere before that point.
 */
export function estimateProtocolFeeUsd(notionalUsd: number): number {
  return notionalUsd * (AAVE_FLASHLOAN_FEE_BPS / 10000);
}

/**
 * Returns an estimated USD cost for real-world slippage/spread decay
 * between the scanner's pre-trade quote and actual execution-time
 * pricing across both swap legs. This is a buffer, not a precise
 * prediction — its purpose is to stop trades whose margin is too
 * thin to survive realistic slippage from ever reaching Enso, where
 * a failed attempt still costs a wasted API call and (per queue.ts's
 * retry loop) delays discovery of genuinely better opportunities.
 */
export function estimateSlippageBufferUsd(notionalUsd: number): number {
  return notionalUsd * (ESTIMATED_SLIPPAGE_BUFFER_BPS / 10000);
}

export interface FullCostEstimate {
  gasCostUsd: number;
  protocolFeeUsd: number;
  slippageBufferUsd: number;
  totalCostUsd: number;
}

export async function estimateFullCost(
  notionalUsd: number,
  nativeUsdPrice: number,
  gasUnits: number = ESTIMATED_GAS_UNITS.flashloanArbitrage
): Promise<FullCostEstimate> {
  const gas = await estimateGasCostUsd(gasUnits, nativeUsdPrice);
  const protocolFeeUsd = estimateProtocolFeeUsd(notionalUsd);
  const slippageBufferUsd = estimateSlippageBufferUsd(notionalUsd);

  const estimate = {
    gasCostUsd: gas.costUsd,
    protocolFeeUsd,
    slippageBufferUsd,
    totalCostUsd: gas.costUsd + protocolFeeUsd + slippageBufferUsd,
  };

  log.debug('Full cost estimate', estimate);
  return estimate;
}