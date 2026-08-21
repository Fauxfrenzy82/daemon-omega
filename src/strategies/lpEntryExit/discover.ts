import { ethers } from 'ethers';
import { TokenInfo } from '../../config/tokens';
import { getDirectDexQuote, DirectDexQuote } from '../../scanner/sources/directDexSource';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { enabledPairs } from '../../config/pairs';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';

const log = createLogger('lpEntryExit');

// Only use venues that support execution
const SUPPORTED_VENUES = ['uniswap-v3', 'sushiswap-v2', 'quickswap-v2'];

function getTokenPriceUsd(token: TokenInfo): number {
  if (['USDC', 'USDC.e', 'USDT', 'DAI'].includes(token.symbol)) {
    return 1.0;
  }
  const priceMap: Record<string, number> = {
    'WMATIC': 0.5,
    'WETH': 3000,
    'WBTC': 60000,
    'LINK': 15,
    'AAVE': 150,
    'GHST': 1.5,
    'QUICK': 0.05,
  };
  return priceMap[token.symbol] || 0.01;
}

export async function discoverLPEntryExit(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];
  const pairs = enabledPairs();

  for (const pair of pairs) {
    const positionUsd = pair.maxPositionUsd;
    const quoteToken = pair.quote;
    const baseToken = pair.base;

    // Convert USD position to raw amount of quote token
    const quotePrice = getTokenPriceUsd(quoteToken);
    const quoteAmountHuman = positionUsd / quotePrice;
    const amountInRaw = ethers.utils.parseUnits(
      quoteAmountHuman.toFixed(quoteToken.decimals),
      quoteToken.decimals
    ).toString();

    // Get buy quotes: quote -> base
    const buyQuotes = await Promise.all(
      SUPPORTED_VENUES.map(v => getDirectDexQuote(v, quoteToken, baseToken, amountInRaw))
    );
    const validBuys = buyQuotes.filter((q): q is DirectDexQuote => q !== null);
    if (validBuys.length === 0) continue;

    // For each buy, get sell quotes from other venues
    const sellQuotesByBuy: Map<string, DirectDexQuote[]> = new Map();
    for (const buy of validBuys) {
      const sellQuotes = await Promise.all(
        SUPPORTED_VENUES
          .filter(v => v !== buy.venue)
          .map(v => getDirectDexQuote(v, baseToken, quoteToken, buy.amountOut))
      );
      const validSells = sellQuotes.filter((q): q is DirectDexQuote => q !== null);
      sellQuotesByBuy.set(buy.venue, validSells);
    }

    // Find best round-trip
    let bestNetProfit = -Infinity;
    let bestBuy: DirectDexQuote | null = null;
    let bestSell: DirectDexQuote | null = null;
    let bestGrossProfit = 0;

    for (const buy of validBuys) {
      const sells = sellQuotesByBuy.get(buy.venue) || [];
      for (const sell of sells) {
        // Calculate end amount: start with quote, buy base, sell back to quote
        const buyAmountOutHuman = Number(buy.amountOut) / 10 ** baseToken.decimals;
        const sellPrice = (Number(sell.amountOut) / 10 ** quoteToken.decimals) /
                          (Number(sell.amountIn) / 10 ** baseToken.decimals);
        const endAmountHuman = buyAmountOutHuman * sellPrice;
        const startAmountHuman = Number(amountInRaw) / 10 ** quoteToken.decimals;
        const grossProfitHuman = endAmountHuman - startAmountHuman;
        const grossProfitUsd = grossProfitHuman * quotePrice;

        // Estimate costs
        const estimatedGasUsd = 0.05 * nativePriceUsd; // rough
        const protocolFeeUsd = grossProfitUsd * 0.0005; // 0.05% Aave fee
        const netProfitUsd = grossProfitUsd - estimatedGasUsd - protocolFeeUsd;

        if (netProfitUsd > bestNetProfit && netProfitUsd > env.DEFAULT_MIN_PROFIT_USD) {
          bestNetProfit = netProfitUsd;
          bestBuy = buy;
          bestSell = sell;
          bestGrossProfit = grossProfitUsd;
        }
      }
    }

    if (bestBuy && bestSell) {
      const candidate: OpportunityCandidate = {
        id: `lp-${pair.id}-${bestBuy.venue}-${bestSell.venue}-${Date.now()}`,
        strategy: 'lpEntryExit',
        protocol: 'uniswap-v3',
        params: {
          pairId: pair.id,
          buyVenue: bestBuy.venue,
          sellVenue: bestSell.venue,
          buyQuote: bestBuy,
          sellQuote: bestSell,
          amountInRaw,
          nativePriceUsd,
        },
        estimatedGrossProfitUsd: bestGrossProfit,
        estimatedNetProfitUsd: bestNetProfit,
        estimatedCostUsd: bestGrossProfit - bestNetProfit,
        actionPlan: null,
        sourceTimestamp: Date.now(),
      };
      candidates.push(candidate);
      log.debug(`Found LP candidate: ${pair.id} ${bestBuy.venue}->${bestSell.venue}`, {
        grossProfitUsd: bestGrossProfit.toFixed(4),
        netProfitUsd: bestNetProfit.toFixed(4),
      });
    }
  }

  log.info(`LP Entry/Exit found ${candidates.length} candidates`);
  return candidates;
}