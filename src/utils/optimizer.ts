import { TokenInfo } from '../config/tokens';
import { getEnsoRouteQuote } from '../scanner/sources/ensoRoute';
import { getDirectDexQuote, DirectDexQuote } from '../scanner/sources/directDexSource';
import { createLogger } from './logger';

const log = createLogger('optimizer');

/**
 * Compute price impact from a quote by comparing effective price to a reference price.
 * This is a heuristic; for V2 we can compute from reserves but we rely on Enso's reported impact if available.
 */
function estimatePriceImpact(quote: { price: number; tokenIn: TokenInfo; tokenOut: TokenInfo; amountIn: string }, referencePrice: number): number {
  // If quote has raw priceImpact from Enso, use it
  if ((quote as any).raw?.priceImpact !== undefined) {
    return (quote as any).raw.priceImpact;
  }
  // Fallback: compare to reference price (could be from a small quote)
  if (referencePrice > 0 && quote.price > 0) {
    return Math.abs((quote.price - referencePrice) / referencePrice) * 10000;
  }
  return 0;
}

/**
 * Bounded search (ternary) to find trade size that maximizes net profit for a given pair and venue.
 * Uses Enso route as primary, falls back to direct quote if needed.
 * @param tokenIn - token to sell
 * @param tokenOut - token to buy
 * @param minSizeUsd - minimum trade size in USD (e.g., 10)
 * @param maxSizeUsd - maximum trade size in USD (e.g., 10000)
 * @param nativePriceUsd - native token price for gas estimation
 * @param useEnso - whether to use Enso route or direct venue quotes
 * @param excludeVenues - venues to exclude (for direct mode)
 * @param pairId - for logging
 * @returns optimal trade size in USD (or 0 if none profitable)
 */
export async function findOptimalTradeSize(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  minSizeUsd: number,
  maxSizeUsd: number,
  nativePriceUsd: number,
  useEnso: boolean = true,
  excludeVenues: string[] = [],
  pairId: string = 'unknown'
): Promise<{ optimalSizeUsd: number; bestNetProfitUsd: number; quote: any }> {
  // Convert USD sizes to raw token amounts using a reference price (we'll use the price from a small quote)
  // First get a reference price from a very small amount (e.g., $1)
  const referenceAmountRaw = ethers.utils.parseUnits(
    (1 / getTokenPriceUsd(tokenIn)).toString(),
    tokenIn.decimals
  ).toString();

  let referencePrice: number = 0;
  let referenceQuote: any = null;

  if (useEnso) {
    const ref = await getEnsoRouteQuote(tokenIn, tokenOut, referenceAmountRaw);
    if (ref) {
      referencePrice = ref.price;
      referenceQuote = ref;
    }
  } else {
    // Use direct venue; pick the best among supported venues
    const venues = ['uniswap-v3', 'sushiswap-v2', 'quickswap-v2'].filter(v => !excludeVenues.includes(v));
    const quotes = await Promise.all(venues.map(v => getDirectDexQuote(v, tokenIn, tokenOut, referenceAmountRaw)));
    const valid = quotes.filter((q): q is DirectDexQuote => q !== null);
    if (valid.length > 0) {
      const best = valid.reduce((a, b) => (Number(a.amountOut) > Number(b.amountOut) ? a : b));
      referencePrice = best.price;
      referenceQuote = best;
    }
  }

  if (!referenceQuote || referencePrice <= 0) {
    log.warn(`Could not get reference price for ${pairId}, skipping optimization`);
    return { optimalSizeUsd: 0, bestNetProfitUsd: 0, quote: null };
  }

  // Now perform ternary search over USD sizes
  const objective = async (sizeUsd: number): Promise<{ netProfit: number; quote: any }> => {
    // Convert size to raw amount
    const amountInHuman = sizeUsd / getTokenPriceUsd(tokenIn);
    const amountInRaw = ethers.utils.parseUnits(amountInHuman.toFixed(tokenIn.decimals), tokenIn.decimals).toString();

    let quote: any = null;
    if (useEnso) {
      quote = await getEnsoRouteQuote(tokenIn, tokenOut, amountInRaw);
    } else {
      // Direct: get best among venues
      const venues = ['uniswap-v3', 'sushiswap-v2', 'quickswap-v2'].filter(v => !excludeVenues.includes(v));
      const quotes = await Promise.all(venues.map(v => getDirectDexQuote(v, tokenIn, tokenOut, amountInRaw)));
      const valid = quotes.filter((q): q is DirectDexQuote => q !== null);
      if (valid.length === 0) return { netProfit: -Infinity, quote: null };
      quote = valid.reduce((a, b) => (Number(a.amountOut) > Number(b.amountOut) ? a : b));
    }

    if (!quote) return { netProfit: -Infinity, quote: null };

    // Compute gross profit (in USD) from quote
    const amountOutHuman = Number(quote.amountOut) / 10 ** tokenOut.decimals;
    const amountInHumanQuote = Number(quote.amountIn) / 10 ** tokenIn.decimals;
    // If we are selling tokenIn to get tokenOut, gross profit = (amountOut * priceOutUsd) - (amountIn * priceInUsd)
    const priceOutUsd = getTokenPriceUsd(tokenOut);
    const priceInUsd = getTokenPriceUsd(tokenIn);
    const grossProfitUsd = (amountOutHuman * priceOutUsd) - (amountInHumanQuote * priceInUsd);

    // Estimate costs: gas + protocol fees (simplified)
    const gasEstimateUsd = 0.05 * nativePriceUsd; // rough
    const protocolFeeUsd = grossProfitUsd * 0.0005; // 0.05% Aave fee
    const netProfit = grossProfitUsd - gasEstimateUsd - protocolFeeUsd;

    // Also check price impact: if impact exceeds MAX_PRICE_IMPACT_BPS, penalize heavily
    const impact = estimatePriceImpact(quote, referencePrice);
    if (impact > env.MAX_PRICE_IMPACT_BPS) {
      return { netProfit: -Infinity, quote };
    }

    return { netProfit, quote };
  };

  // Ternary search over [minSizeUsd, maxSizeUsd] with 20 iterations
  let left = minSizeUsd;
  let right = maxSizeUsd;
  let bestSize = 0;
  let bestNetProfit = -Infinity;
  let bestQuote = null;

  for (let i = 0; i < 20; i++) {
    const m1 = left + (right - left) / 3;
    const m2 = right - (right - left) / 3;

    const res1 = await objective(m1);
    const res2 = await objective(m2);

    if (res1.netProfit > res2.netProfit) {
      right = m2;
      if (res1.netProfit > bestNetProfit) {
        bestNetProfit = res1.netProfit;
        bestSize = m1;
        bestQuote = res1.quote;
      }
    } else {
      left = m1;
      if (res2.netProfit > bestNetProfit) {
        bestNetProfit = res2.netProfit;
        bestSize = m2;
        bestQuote = res2.quote;
      }
    }
  }

  // Also check boundaries
  const boundaries = [minSizeUsd, maxSizeUsd, (minSizeUsd + maxSizeUsd) / 2];
  for (const size of boundaries) {
    const res = await objective(size);
    if (res.netProfit > bestNetProfit) {
      bestNetProfit = res.netProfit;
      bestSize = size;
      bestQuote = res.quote;
    }
  }

  if (bestNetProfit <= 0) {
    return { optimalSizeUsd: 0, bestNetProfitUsd: 0, quote: null };
  }

  return { optimalSizeUsd: bestSize, bestNetProfitUsd: bestNetProfit, quote: bestQuote };
}

// Helper to get token price in USD (simplified, should be improved)
function getTokenPriceUsd(token: TokenInfo): number {
  if (['USDC', 'USDC.e', 'USDT', 'DAI'].includes(token.symbol)) {
    return 1.0;
  }
  const priceMap: Record<string, number> = {
    'WMATIC': 0.1, // approximate, will be overridden by actual quotes
    'WETH': 3000,
    'WBTC': 60000,
    'LINK': 15,
    'AAVE': 150,
    'GHST': 1.5,
    'QUICK': 0.05,
  };
  return priceMap[token.symbol] || 0.01;
}

// Import env at runtime to avoid circular
import { env } from '../config/env';
import { ethers } from 'ethers';
import { getEnsoRouteQuote } from '../scanner/sources/ensoRoute';