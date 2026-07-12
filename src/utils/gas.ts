import { ethers } from 'ethers';
import { provider } from '../treasury/wallets';
import { createLogger } from './logger';

const log = createLogger('gas');

// Polygon minimum priority fee (tip) required by validators
const MIN_PRIORITY_FEE_GWEI = 25;
const GAS_BUFFER_GWEI = 10;

export interface GasPrices {
  maxPriorityFeePerGas: ethers.BigNumber;
  maxFeePerGas: ethers.BigNumber;
}

/**
 * Returns safe gas prices for Polygon transactions.
 * - Always meets the 25 Gwei minimum priority fee
 * - Adds a buffer to the max fee to account for network spikes
 * - Falls back to safe defaults if fee data is unavailable
 */
export async function getSafeGasPrices(): Promise<GasPrices> {
  try {
    const feeData = await provider.getFeeData();

    // Parse the priority fee (tip) — use minimum or current, whichever is higher
    const currentTip = feeData.maxPriorityFeePerGas || ethers.utils.parseUnits('30', 'gwei');
    const minTip = ethers.utils.parseUnits(String(MIN_PRIORITY_FEE_GWEI), 'gwei');
    const priorityFee = currentTip.gt(minTip) ? currentTip : minTip;

    // Parse the max fee (base + tip + buffer)
    const baseFee = feeData.maxFeePerGas || ethers.utils.parseUnits('50', 'gwei');
    const buffer = ethers.utils.parseUnits(String(GAS_BUFFER_GWEI), 'gwei');
    const maxFee = baseFee.add(priorityFee).add(buffer);

    log.debug('Gas prices calculated', {
      priorityFeeGwei: Number(ethers.utils.formatUnits(priorityFee, 'gwei')).toFixed(1),
      maxFeeGwei: Number(ethers.utils.formatUnits(maxFee, 'gwei')).toFixed(1),
    });

    return {
      maxPriorityFeePerGas: priorityFee,
      maxFeePerGas: maxFee,
    };
  } catch (error) {
    // Fallback: use conservative defaults
    log.warn('Failed to fetch gas prices from network, using defaults', {
      error: error instanceof Error ? error.message : String(error),
    });

    const tip = ethers.utils.parseUnits('30', 'gwei');
    const maxFee = ethers.utils.parseUnits('60', 'gwei');

    return {
      maxPriorityFeePerGas: tip,
      maxFeePerGas: maxFee,
    };
  }
}

/**
 * Convenience function to get gas prices with a custom multiplier.
 * Useful if you want to increase gas during high congestion.
 */
export async function getGasPricesWithMultiplier(multiplier: number = 1.0): Promise<GasPrices> {
  const prices = await getSafeGasPrices();
  if (multiplier === 1.0) return prices;

  const maxFee = prices.maxFeePerGas.mul(Math.floor(multiplier * 100)).div(100);
  const priorityFee = prices.maxPriorityFeePerGas.mul(Math.floor(multiplier * 100)).div(100);

  return {
    maxPriorityFeePerGas: priorityFee,
    maxFeePerGas: maxFee,
  };
}