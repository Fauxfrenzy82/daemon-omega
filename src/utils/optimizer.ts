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

function extractGas(quote: any): number {
  if (quote && typeof quote === 'object' && 'gas' in quote) {
    const gas = Number(quote.gas);
    if (!isNaN(gas) && gas > 0) return gas;
  }
  return 200000; // fallback
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
): Promise<{ optimalSizeUsd: number; bestNetProfitUsd: number; estimatedCostUsd: number; buyQuote: any; sellQuote: any }> {
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

  // Reduced sample count: 4 samples max (high-to-low)
  const sampleCount = Math.min(4, Math.max(3, env.OPTIMIZER_SAMPLES ?? 4));
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

  const quoteTokenPrice = await getStablePrice(tokenIn);

  for (const sizeUsd of sampleSizes) {
    const amountInHuman = sizeUsd / quoteTokenPrice;
    const amountInRaw = ethers.utils.parseUnits(
      amountInHuman.toFixed(tokenIn.decimals),
      tokenIn.decimals
    ).toString();

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

    const buyAmountOut = buyQuote.amountOut;

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

    const buyAmountInHuman = Number(amountInRaw) / 10 ** tokenIn.decimals;
    const sellAmountOutHuman = Number(sellQuote.amountOut) / 10 ** tokenIn.decimals;
    const grossProfitUsd = (sellAmountOutHuman - buyAmountInHuman) * quoteTokenPrice;

    // Real gas cost from quotes
    const gasPrice = await provider.getGasPrice();
    const gasPriceGwei = Number(ethers.utils.formatUnits(gasPrice, 'gwei'));
    const buyGas = extractGas(buyQuote);
    const sellGas = extractGas(sellQuote);
    const totalGasUnits = buyGas + sellGas;
    const gasCostNative = (gasPriceGwei * totalGasUnits) / 1e9;
    const gasCostUsd = gasCostNative * nativePriceUsd;

    const dexFeeBps = 30;
    const protocolFeeUsd = (sizeUsd * dexFeeBps) / 10000;
    const slippageBufferBps = 12;
    const slippageCostUsd = (sizeUsd * slippageBufferBps) / 10000;

    const totalCost = gasCostUsd + protocolFeeUsd + slippageCostUsd;
    const netProfit = grossProfitUsd - totalCost;

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

async function getStablePrice(token: TokenInfo): Promise<number> {
  if (token.symbol === 'USDC' || token.symbol === 'USDT' || token.symbol === 'DAI' || token.symbol === 'USDC.e') {
    return 1.0;
  }
  return 1.0;
}