import { TokenInfo } from '../config/tokens';
import { getEnsoRouteQuote } from '../scanner/sources/ensoRoute';
import { getDirectDexQuote } from '../scanner/sources/directDexSource';
import { createLogger } from './logger';

const log = createLogger('priceUtils');

// Price cache: token symbol -> { price: number, timestamp: number }
const priceCache = new Map<string, { price: number; timestamp: number }>();
const CACHE_TTL_MS = 60000; // 1 minute

// Stablecoin symbols used as reference
const STABLECOINS = ['USDC', 'USDC.e', 'USDT', 'DAI'];

/**
 * Get live price of a token in USD using Enso route (preferred) or direct DEX quote.
 * Caches results for 1 minute.
 */
export async function getLiveTokenPriceUsd(token: TokenInfo): Promise<number> {
  // If token is a stablecoin, return 1.0 directly
  if (STABLECOINS.includes(token.symbol)) {
    return 1.0;
  }

  // Check cache
  const cached = priceCache.get(token.symbol);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.price;
  }

  try {
    // Use a stablecoin as the other side (e.g., USDC)
    // Find a stablecoin that is not the same as the token
    const stableToken = getStablecoin();
    if (!stableToken) {
      throw new Error('No stablecoin available for price reference');
    }

    // Get a quote: sell 1 unit of the token to get stablecoin
    const amountIn = ethers.utils.parseUnits('1', token.decimals).toString();
    let quote;
    try {
      // Try Enso route first
      quote = await getEnsoRouteQuote(token, stableToken, amountIn);
    } catch (ensoErr) {
      log.debug(`Enso route failed for ${token.symbol}->${stableToken.symbol}, falling back to direct DEX`);
      // Fallback to direct DEX
      const directQuote = await getDirectDexQuote('uniswap-v3', token, stableToken, amountIn);
      if (directQuote) {
        quote = {
          price: directQuote.price,
          amountOut: directQuote.amountOut,
        };
      }
    }

    if (quote && quote.price > 0) {
      // price is already in terms of stablecoin per token, so that's the USD price
      const price = quote.price;
      priceCache.set(token.symbol, { price, timestamp: Date.now() });
      return price;
    }

    throw new Error(`Could not get price for ${token.symbol}`);
  } catch (err) {
    log.warn(`Failed to get live price for ${token.symbol}, using fallback`, {
      error: err instanceof Error ? err.message : String(err),
    });
    // Fallback to hardcoded value (last resort)
    return getFallbackPrice(token);
  }
}

function getStablecoin(): TokenInfo | null {
  // Import tokens dynamically to avoid circular dependency
  const { TOKENS } = require('../config/tokens');
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

// Import ethers at runtime
import { ethers } from 'ethers';