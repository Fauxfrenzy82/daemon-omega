import { ethers } from 'ethers';
import { TokenInfo } from '../config/tokens';
import { getEnsoRouteQuote } from '../scanner/sources/ensoRoute';
import { getDirectDexQuote, DirectDexQuote } from '../scanner/sources/directDexSource';
import { createLogger } from './logger';
import { env } from '../config/env';
import { provider } from '../treasury/wallets';

const log = createLogger('optimizer');

function estimatePriceImpact(quote: { price: number; tokenIn: TokenInfo; tokenOut: TokenInfo; amountIn: string }, referencePrice: number): number {
  if ((quote as any).raw?.priceImpact !== undefined) {
    return (quote as any).raw.priceImpact;
  }
  if (referencePrice > 0 && quote.price > 0) {
    return Math.abs((quote.price - referencePrice) / referencePrice) * 10000;
  }
  return 0;
}

export async function findOptimalTradeSize(
  tokenIn: TokenInfo,      // quote token (e.g., USDC)
  tokenOut: TokenInfo,     // base token (e.g., GHST)
  minSizeUsd: number,
  maxSizeUsd: number,
  nativePriceUsd: number,
  useEnso: boolean = true,
  excludeVenues: string[] = [],
  pairId: string = 'unknown'
): Promise<{ optimalSizeUsd: number; bestNetProfitUsd: number; estimatedCostUsd: number; buyQuote: any; sellQuote: any }> {
  // Reference price for impact estimation (using a tiny amount)
  const refAmountRaw = ethers.utils.parseUnits(
    (1 / (await getStablePrice(tokenIn))).toString(),
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
    return { optimalSizeUsd: 0, bestNetProfitUsd: 0, estimatedCostUsd: 0, buyQuote: null, sellQuote: null };
  }

  // Fixed number of samples (5-10), configurable via env
  const sampleCount = Math.min(10, Math.max(5, env.OPTIMIZER_SAMPLES ?? 8));
  const step = (maxSizeUsd - minSizeUsd) / (sampleCount - 1);
  const sampleSizes: number[] = [];
  // Sample from high to low
  for (let i = sampleCount - 1; i >= 0; i--) {
    sampleSizes.push(minSizeUsd + i * step);
  }

  let bestSize = 0;
  let bestNetProfit = -Infinity;
  let bestBuyQuote = null;
  let bestSellQuote = null;
  let bestEstimatedCost = 0;

  // Token price for converting profit to USD (assume USDC = 1)
  const quoteTokenPrice = await getStablePrice(tokenIn);

  for (const sizeUsd of sampleSizes) {
    // Convert size to raw amount of quote token
    const amountInHuman = sizeUsd / quoteTokenPrice;
    const amountInRaw = ethers.utils.parseUnits(
      amountInHuman.toFixed(tokenIn.decimals),
      tokenIn.decimals
    ).toString();

    // 1. Get buy quote: tokenIn -> tokenOut
    let buyQuote: any = null;
    if (useEnso) {
      buyQuote = await getEnsoRouteQuote(tokenIn, tokenOut, amountInRaw);
    } else {
      const venues = ['uniswap-v3', 'sushiswap-v2', 'quickswap-v2'].filter(v => !excludeVenues.includes(v));
      const quotes = await Promise.all(venues.map(v => getDirectDexQuote(v, tokenIn, tokenOut, amountInRaw)));
      const valid = quotes.filter((q): q is DirectDexQuote => q !== null);
      if (valid.length > 0) {
        buyQuote = valid.reduce((a, b) => (Number(a.amountOut) > Number(b.amountOut) ? a : b));
      }
    }
    if (!buyQuote) continue;

    const buyAmountOut = buyQuote.amountOut; // raw amount of tokenOut

    // 2. Get sell quote: tokenOut -> tokenIn, using the exact amountOut from buy
    let sellQuote: any = null;
    if (useEnso) {
      sellQuote = await getEnsoRouteQuote(tokenOut, tokenIn, buyAmountOut);
    } else {
      const venues = ['uniswap-v3', 'sushiswap-v2', 'quickswap-v2'].filter(v => !excludeVenues.includes(v));
      const quotes = await Promise.all(venues.map(v => getDirectDexQuote(v, tokenOut, tokenIn, buyAmountOut)));
      const valid = quotes.filter((q): q is DirectDexQuote => q !== null);
      if (valid.length > 0) {
        sellQuote = valid.reduce((a, b) => (Number(a.amountOut) > Number(b.amountOut) ? a : b));
      }
    }
    if (!sellQuote) continue;

    // 3. Compute round-trip profit in terms of tokenIn (USDC)
    const buyAmountInHuman = Number(amountInRaw) / 10 ** tokenIn.decimals;
    const sellAmountOutHuman = Number(sellQuote.amountOut) / 10 ** tokenIn.decimals;
    const grossProfitUsd = (sellAmountOutHuman - buyAmountInHuman) * quoteTokenPrice;

    // Estimate costs (gas, fees, slippage)
    const gasPrice = await provider.getGasPrice();
    const gasPriceGwei = Number(ethers.utils.formatUnits(gasPrice, 'gwei'));
    const gasUnits = 200000; // placeholder
    const gasCostNative = (gasPriceGwei * gasUnits) / 1e9;
    const gasCostUsd = gasCostNative * nativePriceUsd;

    // Protocol fee (DEX fee) as % of trade size
    const dexFeeBps = 30; // 0.3%
    const protocolFeeUsd = (sizeUsd * dexFeeBps) / 10000;

    // Slippage buffer
    const slippageBufferBps = 12;
    const slippageCostUsd = (sizeUsd * slippageBufferBps) / 10000;

    const totalCost = gasCostUsd + protocolFeeUsd + slippageCostUsd;
    const netProfit = grossProfitUsd - totalCost;

    // Apply price impact filter
    const impact = estimatePriceImpact(buyQuote, referencePrice);
    if (impact > env.MAX_PRICE_IMPACT_BPS) continue;

    if (netProfit > bestNetProfit) {
      bestNetProfit = netProfit;
      bestSize = sizeUsd;
      bestBuyQuote = buyQuote;
      bestSellQuote = sellQuote;
      bestEstimatedCost = totalCost;
    }
  }

  if (bestNetProfit <= 0) {
    return { optimalSizeUsd: 0, bestNetProfitUsd: 0, estimatedCostUsd: 0, buyQuote: null, sellQuote: null };
  }

  log.debug(`Optimizer for ${pairId}: best size $${bestSize.toFixed(2)}, net profit $${bestNetProfit.toFixed(4)}`);
  return {
    optimalSizeUsd: bestSize,
    bestNetProfitUsd: bestNetProfit,
    estimatedCostUsd: bestEstimatedCost,
    buyQuote: bestBuyQuote,
    sellQuote: bestSellQuote
  };
}

// Helper to get price of stablecoin (assume 1)
async function getStablePrice(token: TokenInfo): Promise<number> {
  if (token.symbol === 'USDC' || token.symbol === 'USDT' || token.symbol === 'DAI' || token.symbol === 'USDC.e') {
    return 1.0;
  }
  return 1.0;
}