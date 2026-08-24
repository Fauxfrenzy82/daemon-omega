import { ethers } from 'ethers';
import { TokenInfo } from '../config/tokens';
import { getEnsoRouteQuote } from '../scanner/sources/ensoRoute';
import { getDirectDexQuote } from '../scanner/sources/directDexSource';
import { createLogger } from './logger';
import { TOKENS } from '../config/tokens';
import { provider } from '../treasury/wallets';

const log = createLogger('cache');

// ✅ FIX: Use null as "not initialized", not a hardcoded fallback
let cachedNativePrice: number | null = null;
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
 * ✅ FIX: Returns null if not initialized (so callers know it's unavailable).
 */
export function getCachedNativePrice(): number | null {
  const now = Date.now();
  if (cachedNativePrice === null || now - cachedNativePriceTimestamp > CACHE_TTL_MS) {
    // Fire-and-forget background refresh
    fetchNativePriceInBackground();
  }
  return cachedNativePrice;
}

/**
 * Get cached gas price – lazy initialization only when called.
 */
export function getCachedGasPrice(): ethers.BigNumber | null {
  const now = Date.now();
  if (!cachedGasPrice || now - cachedGasPriceTimestamp > GAS_CACHE_TTL_MS) {
    fetchGasPriceInBackground();
  }
  return cachedGasPrice;
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
// Called lazily, NEVER at top level during import.

async function fetchNativePriceInBackground(): Promise<void> {
  try {
    const price = await getLiveTokenPriceUsd(TOKENS.WMATIC);
    cachedNativePrice = price;
    cachedNativePriceTimestamp = Date.now();
  } catch (err) {
    log.warn('Failed to fetch native price in background', {
      error: err instanceof Error ?