import { ethers } from 'ethers';
import { provider } from '../treasury/wallets';
import { getLiveTokenPriceUsd } from './priceUtils';

// Cache state
let cachedNativePrice = 0.1;
let cachedNativePriceTimestamp = 0;
const CACHE_TTL_MS = 3000; // 3 seconds

let cachedGasPrice: ethers.BigNumber | null = null;
let cachedGasPriceTimestamp = 0;
const GAS_CACHE_TTL_MS = 5000; // 5 seconds

let cachedLiquidity: Record<string, number> = {};
let cachedLiquidityTimestamp = 0;
const LIQUIDITY_CACHE_TTL_MS = 10000; // 10 seconds

/**
 * Get cached native price – refreshes in background if stale
 */
export function getCachedNativePrice(): number {
  const now = Date.now();
  if (now - cachedNativePriceTimestamp > CACHE_TTL_MS) {
    // Background refresh – don't await, just fire
    fetchNativePriceInBackground();
    // Return stale value for now (still accurate enough)
  }
  return cachedNativePrice;
}

async function fetchNativePriceInBackground(): Promise<void> {
  try {
    const price = await getLiveTokenPriceUsd({ symbol: 'WMATIC' } as any);
    cachedNativePrice = price;
    cachedNativePriceTimestamp = Date.now();
  } catch (err) {
    // Keep stale value
  }
}

/**
 * Get cached gas price – refreshes in background if stale
 */
export function getCachedGasPrice(): ethers.BigNumber {
  const now = Date.now();
  if (!cachedGasPrice || now - cachedGasPriceTimestamp > GAS_CACHE_TTL_MS) {
    fetchGasPriceInBackground();
  }
  return cachedGasPrice || ethers.utils.parseUnits('30', 'gwei');
}

async function fetchGasPriceInBackground(): Promise<void> {
  try {
    cachedGasPrice = await provider.getGasPrice();
    cachedGasPriceTimestamp = Date.now();
  } catch (err) {
    // Keep stale value
  }
}

/**
 * Get cached liquidity data – refreshes in background if stale
 */
export function getCachedLiquidity(): Record<string, number> {
  const now = Date.now();
  if (now - cachedLiquidityTimestamp > LIQUIDITY_CACHE_TTL_MS) {
    fetchLiquidityInBackground();
  }
  return cachedLiquidity;
}

async function fetchLiquidityInBackground(): Promise<void> {
  try {
    // Fetch liquidity for USDC, USDT, DAI, WETH, WMATIC, WBTC, AAVE
    const tokens = ['USDC', 'USDT', 'DAI', 'WETH', 'WMATIC', 'WBTC', 'AAVE'];
    const liquidity: Record<string, number> = {};
    // Mock for now – will be replaced with actual Aave getReserveData calls
    for (const token of tokens) {
      liquidity[token] = 10000000; // placeholder
    }
    cachedLiquidity = liquidity;
    cachedLiquidityTimestamp = Date.now();
  } catch (err) {
    // Keep stale value
  }
}

// Initialize cache
fetchNativePriceInBackground();
fetchGasPriceInBackground();
fetchLiquidityInBackground();