import { ethers } from 'ethers';
import { TokenInfo } from '../config/tokens';
import { getEnsoRouteQuote } from '../scanner/sources/ensoRoute';
import { getDirectDexQuote } from '../scanner/sources/directDexSource';
import { createLogger } from './logger';
import { TOKENS } from '../config/tokens';
import { provider } from '../treasury/wallets';

const log = createLogger('priceUtils');

// Cache – initially empty, populated on first demand
let cachedNativePrice = 0.1;
let cachedNativePriceTimestamp = 0;
const CACHE_TTL_MS = 3000;

let cachedGasPrice: ethers.BigNumber | null = null;
let cachedGasPriceTimestamp = 0;
const GAS_CACHE_TTL_MS = 5000;

let cachedLiquidity: Record<string, number> = {};
let cachedLiquidityTimestamp = 0;
const LIQUIDITY_CACHE_TTL_MS = 10000;

const STABLECOINS = ['USDC', 'USDC.e', 'USDT', 'DAI'];
const priceCache = new Map<string, { price: number; timestamp: number }>();
const PRICE_CACHE_TTL_MS = 60000;

/**
 * Get live price of a token in USD – lazily fetches on first call.
 * NEVER called at top level – only when explicitly requested.
 */
export async function getLiveTokenPriceUsd(token: TokenInfo): Promise<number> {
  if (STABLECOINS.includes(token.symbol)) {
    return 1.0;
  }

  const cached = priceCache.get(token.symbol);
  if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL_MS) {
    return cached.price;
  }

  try {
    const stableToken = getStablecoin();
    if (!stableToken) {
      throw new Error('No stablecoin available');
    }

    const amountIn = ethers.utils.parseUnits('1', token.decimals).toString();
    let quote;

    try {
      quote = await getEnsoRouteQuote(token, stableToken, amountIn);
    } catch (ensoErr) {
      log.debug(`Enso route failed for ${token.symbol}, falling back to direct DEX`);
      const directQuote = await getDirectDexQuote('uniswap-v3', token, stableToken, amountIn);
      if (directQuote) {
        quote = { price: directQuote.price, amountOut: directQuote.amountOut };
      }
    }

    if (quote && quote.price > 0) {
      priceCache.set(token.symbol, { price: quote.price, timestamp: Date.now() });
      return quote.price;
    }

    throw new Error(`Could not get price for ${token.symbol}`);
  } catch (err) {
    log.warn(`Failed to get live price for ${token.symbol}, using fallback`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return getFallbackPrice(token);
  }
}

function getStablecoin(): TokenInfo | null {
  for (const sym of STABLECOINS) {
    if (TOKENS[sym]) return TOKENS[sym];
  }
  return null;
}

function getFallbackPrice(token: TokenInfo): number {
  const fallbackMap: Record<string, number> = {
    'WMATIC': 0.1,
    'WETH': 3000,
    'WBTC': 60000,
    'LINK': 15,
    'AAVE': 150,
    'GHST': 1.5,
    'QUICK': 0.05,
  };
  return fallbackMap[token.symbol] || 0.01;
}

/**
 * Get cached native price – lazy initialization only when called.
 * NEVER called at top level.
 */
export function getCachedNativePrice(): number {
  const now = Date.now();
  if (now - cachedNativePriceTimestamp > CACHE_TTL_MS) {
    // Fire-and-forget background refresh
    fetchNativePriceInBackground();
  }
  return cachedNativePrice;
}

/**
 * Get cached gas price – lazy initialization only when called.
 */
export function getCachedGasPrice(): ethers.BigNumber {
  const now = Date.now();
  if (!cachedGasPrice || now - cachedGasPriceTimestamp > GAS_CACHE_TTL_MS) {
    fetchGasPriceInBackground();
  }
  return cachedGasPrice || ethers.utils.parseUnits('30', 'gwei');
}

/**
 * Get cached liquidity data – lazy initialization only when called.
 */
export function getCachedLiquidity(): Record<string, number> {
  const now = Date.now();
  if (now - cachedLiquidityTimestamp > LIQUIDITY_CACHE_TTL_MS) {
    fetchLiquidityInBackground();
  }
  return cachedLiquidity;
}

// ========== Background refresh functions ==========
// These are called lazily, NEVER at top level during import.

async function fetchNativePriceInBackground(): Promise<void> {
  try {
    // Use WMATIC as native token proxy
    const price = await getLiveTokenPriceUsd(TOKENS.WMATIC);
    cachedNativePrice = price;
    cachedNativePriceTimestamp = Date.now();
  } catch (err) {
    // Keep stale value
  }
}

async function fetchGasPriceInBackground(): Promise<void> {
  try {
    cachedGasPrice = await provider.getGasPrice();
    cachedGasPriceTimestamp = Date.now();
  } catch (err) {
    // Keep stale value
  }
}

async function fetchLiquidityInBackground(): Promise<void> {
  try {
    // Placeholder – replace with actual Aave liquidity fetch if needed
    const liquidity: Record<string, number> = {};
    const tokens = ['USDC', 'USDT', 'DAI', 'WETH', 'WMATIC', 'WBTC', 'AAVE'];
    for (const token of tokens) {
      liquidity[token] = 10000000;
    }
    cachedLiquidity = liquidity;
    cachedLiquidityTimestamp = Date.now();
  } catch (err) {
    // Keep stale value
  }
}