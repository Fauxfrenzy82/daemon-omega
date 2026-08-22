import { ethers } from 'ethers';
import { TokenInfo } from '../config/tokens';
import { getEnsoRouteQuote } from '../scanner/sources/ensoRoute';
import { getDirectDexQuote, DirectDexQuote } from '../scanner/sources/directDexSource';
import { createLogger } from './logger';
import { env } from '../config/env';
import { getLiveTokenPriceUsd } from './priceUtils';
import { provider } from '../treasury/wallets';

const log = createLogger('optimizer');

/**
 * Compute price impact from a quote by comparing effective price to a reference price.
 */
function estimatePriceImpact(quote: { price: number; tokenIn: TokenInfo; tokenOut: TokenInfo; amountIn: string }, referencePrice: number): number {
  if ((quote as any).raw?.priceImpact !== undefined) {
    return (quote as any).raw.priceImpact;
  }
  if (referencePrice > 0 && quote.price > 0) {
    return Math.abs((quote.price - referencePrice) / referencePrice) * 10000;
  }
  return 0;
}

/**
 * Bounded search to find optimal trade size.
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
  // Get live token prices
  const priceIn = await getLiveTokenPriceUsd(tokenIn);
  const priceOut = await getLiveTokenPriceUsd(tokenOut);
  if (priceIn <= 0 || priceOut <= 0) {
    log.warn(`Invalid prices for ${pairId}: in=${priceIn}, out=${priceOut}`);
    return { optimalSizeUsd: 0, bestNetProfitUsd: 0, quote: null };
  }

  // Reference quote for price impact estimation
  const refAmountRaw = ethers.utils.parseUnits(
    (1 / priceIn).toString(),
    tokenIn.decimals
  ).toString();

  let referencePrice: number = 0;
  let referenceQuote: any = null;

  if (useEnso) {
    const ref = await getEnsoRouteQuote(tokenIn, tokenOut, refAmountRaw);
    if (ref) {
      referencePrice = ref.price;
      referenceQuote = ref;
    }
  } else {
    const venues = ['uniswap-v3', 'sushiswap-v2', 'quickswap-v2'].filter(v => !excludeVenues.includes(v));
    const quotes = await Promise.all(venues.map(v => getDirectDexQuote(v, tokenIn, tokenOut, refAmountRaw)));
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

  const objective = async (sizeUsd: number): Promise<{ netProfit: number; quote: any }> => {
    const amountInHuman = sizeUsd / priceIn;
    const amountInRaw = ethers.utils.parseUnits(amountInHuman.toFixed(tokenIn.decimals), tokenIn.decimals).toString();

    let quote: any = null;
    if (useEnso) {
      quote = await getEnsoRouteQuote(tokenIn, tokenOut, amountInRaw);
    } else {
      const venues = ['uniswap-v3', 'sushiswap-v2', 'quickswap-v2'].filter(v => !excludeVenues.includes(v));
      const quotes = await Promise.all(venues.map(v => getDirectDexQuote(v, tokenIn, tokenOut, amountInRaw)));
      const valid = quotes.filter((q): q is DirectDexQuote => q !== null);
      if (valid.length === 0) return { netProfit: -Infinity, quote: null };
      quote = valid.reduce((a, b) => (Number(a.amountOut) > Number(b.amountOut) ? a : b));
    }

    if (!quote) return { netProfit: -Infinity, quote: null };

    const amountOutHuman = Number(quote.amountOut) / 10 ** tokenOut.decimals;
    const amountInHumanQuote = Number(quote.amountIn) / 10 ** tokenIn.decimals;

    const grossProfitUsd = (amountOutHuman * priceOut) - (amountInHumanQuote * priceIn);

    // Estimate gas cost from actual gas price (use provider)
    const gasPrice = await provider.getGasPrice();
    const gasPriceGwei = Number(ethers.utils.formatUnits(gasPrice, 'gwei'));
    const gasUnits = 200000; // placeholder, should come from real estimation
    const gasCostNative = (gasPriceGwei * gasUnits) / 1e9;
    const gasCostUsd = gasCostNative * nativePriceUsd;

    // Protocol fee (e.g., DEX fee) as percentage of trade size (not profit)
    const dexFeeBps = 30; // 0.3% typical for V2, adjust per venue
    const protocolFeeUsd = (sizeUsd * dexFeeBps) / 10000;

    // Slippage cost: price impact already captured, but we'll add a small buffer
    const slippageBufferBps = 12; // per spec
    const slippageCostUsd = (sizeUsd * slippageBufferBps) / 10000;

    const totalCost = gasCostUsd + protocolFeeUsd + slippageCostUsd;
    const netProfit = grossProfitUsd - totalCost;

    // Price impact check
    const impact = estimatePriceImpact(quote, referencePrice);
    if (impact > env.MAX_PRICE_IMPACT_BPS) {
      return { netProfit: -Infinity, quote };
    }

    return { netProfit, quote };
  };

  let left = minSizeUsd;
  let right = maxSizeUsd;
  let bestSize = 0;
  let bestNetProfit = -Infinity;
  let bestQuote = null;

  // Use fewer iterations to reduce time per pair
  const iterations = env.OPTIMIZER_ITERATIONS ?? 10;
  for (let i = 0; i < iterations; i++) {
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

  // Check boundaries
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