import { ethers } from 'ethers';
import { TokenInfo } from '../../config/tokens';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { enabledPairs, PairConfig } from '../../config/pairs';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';
import { findOptimalTradeSize } from '../../utils/optimizer';
import { getEnsoRouteQuote } from '../../scanner/sources/ensoRoute';

const log = createLogger('lpEntryExit');

// Primary vs secondary pairs based on env config
const PRIMARY_PAIR_IDS = env.PRIMARY_PAIR_IDS.split(',').map(s => s.trim());
const SECONDARY_PAIR_IDS = env.SECONDARY_PAIR_IDS.split(',').map(s => s.trim());
const SECONDARY_MAX_POSITION = env.SECONDARY_MAX_POSITION_USD;

export async function discoverLPEntryExit(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];
  const pairs = enabledPairs();

  for (const pair of pairs) {
    const isPrimary = PRIMARY_PAIR_IDS.includes(pair.id);
    const maxSizeUsd = isPrimary ? env.MAX_POSITION_SIZE_USD : Math.min(env.MAX_POSITION_SIZE_USD, SECONDARY_MAX_POSITION);

    // Determine optimal trade size using Enso route (or direct if fallback)
    const useEnso = env.USE_ENSO_ROUTE_PRIMARY;
    const result = await findOptimalTradeSize(
      pair.quote,
      pair.base,
      10, // min size $10
      maxSizeUsd,
      nativePriceUsd,
      useEnso,
      [],
      pair.id
    );

    if (result.optimalSizeUsd <= 0 || result.bestNetProfitUsd <= 0) {
      log.debug(`No profitable opportunity for ${pair.id} at any size`);
      continue;
    }

    // Build candidate from the optimal quote
    const quote = result.quote;
    if (!quote) continue;

    // We need to build buy and sell quotes. The optimizer gave us a quote for the round-trip? Actually findOptimalTradeSize gives a quote for buying base with quote.
    // We need a sell leg for the same size. We'll fetch a sell quote using the amountOut from the buy leg.
    const buyAmountOut = quote.amountOut; // raw
    let sellQuote = null;
    if (useEnso) {
      sellQuote = await getEnsoRouteQuote(pair.base, pair.quote, buyAmountOut);
    } else {
      // Direct: get best sell quote from other venues
      // Since we don't know buy venue, we'll just get best sell from all venues.
      const { getDirectDexQuote } = await import('../../scanner/sources/directDexSource');
      const venues = ['uniswap-v3', 'sushiswap-v2', 'quickswap-v2'];
      const quotes = await Promise.all(venues.map(v => getDirectDexQuote(v, pair.base, pair.quote, buyAmountOut)));
      const valid = quotes.filter((q): q is any => q !== null);
      if (valid.length > 0) {
        sellQuote = valid.reduce((a, b) => (Number(a.amountOut) > Number(b.amountOut) ? a : b));
      }
    }

    if (!sellQuote) {
      log.debug(`No sell quote found for ${pair.id} at optimal size`);
      continue;
    }

    // Compute gross and net profit from the two legs
    const startAmountHuman = Number(quote.amountIn) / 10 ** pair.quote.decimals;
    const endAmountHuman = Number(sellQuote.amountOut) / 10 ** pair.quote.decimals;

    const grossProfitHuman = endAmountHuman - startAmountHuman;
    const grossProfitUsd = grossProfitHuman * getTokenPriceUsd(pair.quote);

    // Costs already accounted in optimizer? We'll compute net again.
    const estimatedGasUsd = 0.05 * nativePriceUsd;
    const protocolFeeUsd = grossProfitUsd * 0.0005;
    const netProfitUsd = grossProfitUsd - estimatedGasUsd - protocolFeeUsd;

    if (netProfitUsd <= env.DEFAULT_MIN_PROFIT_USD) {
      log.debug(`Net profit ${netProfitUsd.toFixed(4)} below threshold for ${pair.id}`);
      continue;
    }

    // Build candidate
    const candidate: OpportunityCandidate = {
      id: `lp-${pair.id}-${Date.now()}`,
      strategy: 'lpEntryExit',
      protocol: useEnso ? 'enso-route' : 'direct',
      params: {
        pairId: pair.id,
        buyQuote: quote,
        sellQuote: sellQuote,
        optimalSizeUsd: result.optimalSizeUsd,
        nativePriceUsd,
        grossProfitUsd,
        netProfitUsd,
      },
      estimatedGrossProfitUsd: grossProfitUsd,
      estimatedNetProfitUsd: netProfitUsd,
      estimatedCostUsd: grossProfitUsd - netProfitUsd,
      actionPlan: null,
      sourceTimestamp: Date.now(),
    };

    candidates.push(candidate);
    log.info(`Found LP candidate for ${pair.id} at size $${result.optimalSizeUsd.toFixed(2)} with net profit $${netProfitUsd.toFixed(4)}`);
  }

  log.info(`LP Entry/Exit found ${candidates.length} candidates`);
  return candidates;
}

// Helper
function getTokenPriceUsd(token: TokenInfo): number {
  if (['USDC', 'USDC.e', 'USDT', 'DAI'].includes(token.symbol)) {
    return 1.0;
  }
  const priceMap: Record<string, number> = {
    'WMATIC': 0.1,
    'WETH': 3000,
    'WBTC': 60000,
    'LINK': 15,
    'AAVE': 150,
    'GHST': 1.5,
    'QUICK': 0.05,
  };
  return priceMap[token.symbol] || 0.01;
}