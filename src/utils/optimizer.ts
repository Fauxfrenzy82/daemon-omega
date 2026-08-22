import { ethers } from 'ethers';
import { TokenInfo } from '../config/tokens';
import { getEnsoRouteQuote } from '../scanner/sources/ensoRoute';
import { getDirectDexQuote, DirectDexQuote } from '../scanner/sources/directDexSource';
import { createLogger } from './logger';
import { env } from '../config/env';
import { getLiveTokenPriceUsd } from './priceUtils';
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

  // Reference price for impact estimation
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
  let bestQuote = null;

  for (const sizeUsd of sampleSizes) {
    const amountInHuman = sizeUsd / priceIn;
    const amountInRaw = ethers.utils.parseUnits(
      amountInHuman.toFixed(tokenIn.decimals),
      tokenIn.decimals
    ).toString();

    let quote: any = null;
    if (useEnso) {
      quote = await getEnsoRouteQuote(tokenIn, tokenOut, amountInRaw);
    } else {
      const venues = ['uniswap-v3', 'sushiswap-v2', 'quickswap-v2'].filter(v => !excludeVenues.includes(v));
      const quotes = await Promise.all(venues.map(v => getDirectDexQuote(v, tokenIn, tokenOut, amountInRaw)));
      const valid = quotes.filter((q): q is DirectDexQuote => q !== null);
      if (valid.length === 0) continue;
      quote = valid.reduce((a, b) => (Number(a.amountOut) > Number(b.amountOut) ? a : b));
    }

    if (!quote) continue;

    const amountOutHuman = Number(quote.amountOut) / 10 ** tokenOut.decimals;
    const amountInHumanQuote = Number(quote.amountIn) / 10 ** tokenIn.decimals;
    const grossProfitUsd = (amountOutHuman * priceOut) - (amountInHumanQuote * priceIn);

    // Estimate gas cost
    const gasPrice = await provider.getGasPrice();
    const gasPriceGwei = Number(ethers.utils.formatUnits(gasPrice, 'gwei'));
    const gasUnits = 200000; // placeholder, can be refined
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

    const impact = estimatePriceImpact(quote, referencePrice);
    if (impact > env.MAX_PRICE_IMPACT_BPS) continue;

    if (netProfit > bestNetProfit) {
      bestNetProfit = netProfit;
      bestSize = sizeUsd;
      bestQuote = quote;
    }
  }

  if (bestNetProfit <= 0) {
    return { optimalSizeUsd: 0, bestNetProfitUsd: 0, quote: null };
  }

  log.debug(`Optimizer for ${pairId}: best size $${bestSize.toFixed(2)}, net profit $${bestNetProfit.toFixed(4)}`);
  return { optimalSizeUsd: bestSize, bestNetProfitUsd: bestNetProfit, quote: bestQuote };
}