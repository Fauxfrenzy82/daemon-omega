import { ethers } from 'ethers';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';

const log = createLogger('feeModel');

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);

export const ESTIMATED_GAS_UNITS = {
  flashloanArbitrage: 550000,
};

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

export function estimateProtocolFeeUsd(_notionalUsd: number): number {
  return 0;
}

export interface FullCostEstimate {
  gasCostUsd: number;
  protocolFeeUsd: number;
  totalCostUsd: number;
}

export async function estimateFullCost(
  notionalUsd: number,
  nativeUsdPrice: number,
  gasUnits: number = ESTIMATED_GAS_UNITS.flashloanArbitrage
): Promise<FullCostEstimate> {
  const gas = await estimateGasCostUsd(gasUnits, nativeUsdPrice);
  const protocolFeeUsd = estimateProtocolFeeUsd(notionalUsd);

  const estimate = {
    gasCostUsd: gas.costUsd,
    protocolFeeUsd,
    totalCostUsd: gas.costUsd + protocolFeeUsd,
  };

  log.debug('Full cost estimate', estimate);

  return estimate;
}