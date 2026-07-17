import { ethers } from 'ethers';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';

const log = createLogger('feeModel');

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);

export const ESTIMATED_GAS_UNITS = {
  flashloanArbitrage: 200000,
};

const AAVE_FLASHLOAN_FEE_BPS = 5;

// RAISED from 25 to 200 bps based on real, measured data: the first
// successfully executed trade (WBTC-USDC, $400 position, Morpho/USDC
// flashloan) was logged as $0.8083 estimated net profit but the
// wallet's actual on-chain balance increase was only $0.01 — a real
// shortfall of ~200 bps, roughly 8x the previous buffer. Enso's real
// route split across multiple pools (Uniswap V4, Ramses V3, and
// others) rather than the simple two-source path our scanner models,
// and each hop adds real slippage our pre-trade spread calculation
// doesn't see. This is one data point, not a statistically robust
// average — it should be revisited as more real trades complete and
// logged (see queue.ts's new actual-profit measurement), but erring
// toward a much larger buffer is the responsible choice until there's
// enough real data to calibrate this more precisely.
const ESTIMATED_SLIPPAGE_BUFFER_BPS = 200;

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

export function estimateProtocolFeeUsd(notionalUsd: number): number {
  return notionalUsd * (AAVE_FLASHLOAN_FEE_BPS / 10000);
}

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