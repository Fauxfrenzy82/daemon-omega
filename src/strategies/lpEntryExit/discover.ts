import { ethers } from 'ethers';
import { TokenInfo } from '../../config/tokens';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { enabledPairs } from '../../config/pairs';
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

    const useEnso = env.USE_ENSO_ROUTE_PRIMARY;
    const result = await findOptimalTradeSize(
      pair.quote,
      pair.base,
      10,
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

    const quote = result.quote;
    if (!quote) {
      log.debug(`No quote returned for ${pair.id} at optimal size`);
      continue;
    }

    // Get sell quote for the same size using the amountOut from buy
    const buyAmountOut = (quote as any).amountOut;
    if (!buyAmountOut) {
      log.debug(`Buy quote missing amountOut for ${pair.id}`);
      continue;
    }

    let sellQuote = null;
    if (useEnso) {
      sellQuote = await getEnsoRouteQuote(pair.base, pair.quote, buyAmountOut);
    } else {
      const { getDirectDexQuote } = await import('../../scanner/sources/directDexSource');
      const venues = ['uniswap-v3', 'sushiswap-v2', 'quickswap-v2'];
      const quotes = await Promise.all(venues.map(v => getDirectDexQuote(v, pair.base, pair.quote, buyAmountOut)));
      // Fix TypeScript error: use type assertion for filter
      const valid = quotes.filter((q): q is NonNullable<typeof quotes[number]> => q !== null);
      if (valid.length > 0) {
        sellQuote = valid.reduce((a, b) => (Number(a.amountOut) > Number(b.amountOut) ? a : b));
      }
    }

    if (!sellQuote) {
      log.debug(`No sell quote found for ${pair.id} at optimal size`);
      continue;
    }

    // Compute gross profit from the two legs (just for logging, net from optimizer is used)
    const startAmountHuman = Number(quote.amountIn) / 10 ** pair.quote.decimals;
    const endAmountHuman = Number(sellQuote.amountOut) / 10 ** pair.quote.decimals;
    const grossProfitHuman = endAmountHuman - startAmountHuman;

    // Use the optimizer's net profit directly
    const netProfitUsd = result.bestNetProfitUsd;

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
        grossProfitUsd: grossProfitHuman * 1.0, // placeholder, not used in decision
        netProfitUsd,
      },
      estimatedGrossProfitUsd: grossProfitHuman * 1.0, // placeholder
      estimatedNetProfitUsd: netProfitUsd,
      estimatedCostUsd: (grossProfitHuman * 1.0) - netProfitUsd,
      actionPlan: null,
      sourceTimestamp: Date.now(),
    };

    candidates.push(candidate);
    log.info(`Found LP candidate for ${pair.id} at size $${result.optimalSizeUsd.toFixed(2)} with net profit $${netProfitUsd.toFixed(4)}`);
  }

  log.info(`LP Entry/Exit found ${candidates.length} candidates`);
  return candidates;
}