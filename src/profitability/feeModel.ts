import { ethers } from 'ethers';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';

const log = createLogger('feeModel');

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);

// Fallback only — used when a quote's real gas figure isn't available
// (e.g. no raw quote data attached). Prefer real per-route gas whenever
// we have it; this constant no longer drives normal-path estimates.
export const ESTIMATED_GAS_UNITS = {
  flashloanArbitrage: 200000,
};

const AAVE_FLASHLOAN_FEE_BPS = 5;

// LOWERED from 200 to 50 bps. The 200 bps figure came from a single
// real trade (WBTC-USDC, $400, routed through Uniswap V4 + Ramses V3
// + others) and was being applied as a flat tax to every pair
// regardless of its actual route complexity - this was filtering out
// genuinely strong opportunities (e.g. WBTC-USDC repeatedly showing
// 48-50 bps real spread, $4.90 gross profit, rejected every cycle
// solely by this buffer) before they ever got a chance to reach
// Enso's real simulation.
//
// The correct division of labor: this evaluator is a CHEAP PRE-FILTER
// to avoid wasting API calls on obviously-hopeless spreads (near-zero
// bps), not a precise profit predictor - Enso's own flashloan
// repayment check already IS the accurate, real-time simulator (it
// caught every genuinely-unprofitable attempt this session with
// correct on-chain math). A pre-filter that's too aggressive costs
// real opportunities; one that's too loose costs a few wasted API
// calls on attempts Enso itself will correctly reject. The latter is
// the safer failure mode. 50 bps is set to comfortably clear the
// Aave fee (5 bps) plus a reasonable single-hop slippage margin,
// while still letting genuine 25+ bps spreads through to Enso, where
// they'll be validated for real.
const ESTIMATED_SLIPPAGE_BUFFER_BPS = 12;

export interface GasCostEstimate {
  gasPriceGwei: number;
  gasUnits: number;
  costNative: number;
  costUsd: number;
  gasUnitsSource: 'quote' | 'fallback-static';
}

/**
 * Pull gas units off a quote's raw Enso bundle response, if present.
 * Enso's bundleData includes a `gas` field (string, e.g. "339361")
 * reflecting the ACTUAL route's estimated gas — this varies a lot by
 * route complexity (single-hop vs multi-hop routeMulti), and using a
 * flat constant here was the root cause of at least one trade passing
 * the pre-filter as profitable and then losing money to real gas costs
 * once executed (multi-hop routeMulti actually used well above the
 * 200k unit assumption). Prefer this over the static constant whenever
 * it's available.
 */
function extractGasUnits(raw: unknown): number | null {
  if (raw && typeof raw === 'object' && 'gas' in (raw as any)) {
    const gasVal = (raw as any).gas;
    const parsed = typeof gasVal === 'string' ? Number(gasVal) : gasVal;
    if (typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

/**
 * Combine buy-leg and sell-leg real gas units, if both quotes carry
 * them. A round trip pays gas for BOTH legs, so both must be summed —
 * using only one leg's gas figure would still underestimate total cost.
 */
export function resolveRoundTripGasUnits(buyRaw: unknown, sellRaw: unknown): {
  gasUnits: number;
  source: 'quote' | 'fallback-static';
} {
  const buyGas = extractGasUnits(buyRaw);
  const sellGas = extractGasUnits(sellRaw);

  if (buyGas !== null && sellGas !== null) {
    return { gasUnits: buyGas + sellGas, source: 'quote' };
  }

  log.warn('Real gas units unavailable from one or both legs, using static fallback', {
    buyGasFound: buyGas !== null,
    sellGasFound: sellGas !== null,
    fallbackUnits: ESTIMATED_GAS_UNITS.flashloanArbitrage,
  });

  return { gasUnits: ESTIMATED_GAS_UNITS.flashloanArbitrage, source: 'fallback-static' };
}

export async function estimateGasCostUsd(
  gasUnits: number,
  nativeUsdPrice: number,
  gasUnitsSource: 'quote' | 'fallback-static' = 'fallback-static'
): Promise<GasCostEstimate> {
  const gasPrice = await withRetry(() => provider.getGasPrice(), {
    label: 'feeModel.getGasPrice',
    shouldRetry: isTransientError,
  });

  const gasPriceGwei = Number(ethers.utils.formatUnits(gasPrice, 'gwei'));
  const costNativeBn = gasPrice.mul(gasUnits);
  const costNative = Number(ethers.utils.formatEther(costNativeBn));
  const costUsd = costNative * nativeUsdPrice;

  return { gasPriceGwei, gasUnits, costNative, costUsd, gasUnitsSource };
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
  gasUnitsUsed: number;
  gasUnitsSource: 'quote' | 'fallback-static';
}

export async function estimateFullCost(
  notionalUsd: number,
  nativeUsdPrice: number,
  gasUnits: number = ESTIMATED_GAS_UNITS.flashloanArbitrage,
  gasUnitsSource: 'quote' | 'fallback-static' = 'fallback-static'
): Promise<FullCostEstimate> {
  const gas = await estimateGasCostUsd(gasUnits, nativeUsdPrice, gasUnitsSource);
  const protocolFeeUsd = estimateProtocolFeeUsd(notionalUsd);
  const slippageBufferUsd = estimateSlippageBufferUsd(notionalUsd);

  const estimate = {
    gasCostUsd: gas.costUsd,
    protocolFeeUsd,
    slippageBufferUsd,
    totalCostUsd: gas.costUsd + protocolFeeUsd + slippageBufferUsd,
    gasUnitsUsed: gasUnits,
    gasUnitsSource,
  };

  log.debug('Full cost estimate', estimate);
  return estimate;
}