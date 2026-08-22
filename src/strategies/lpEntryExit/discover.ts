import { ethers } from 'ethers';
import { TokenInfo } from '../../config/tokens';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { enabledPairs } from '../../config/pairs';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';
import { findOptimalTradeSize } from '../../utils/optimizer';
import { getEnsoRouteQuote } from '../../scanner/sources/ensoRoute';
import { getDirectDexQuote, DirectDexQuote } from '../../scanner/sources/directDexSource';
import { provider } from '../../treasury/wallets';

const log = createLogger('lpEntryExit');

// Primary vs secondary pairs based on env config
const PRIMARY_PAIR_IDS = env.PRIMARY_PAIR_IDS.split(',').map(s => s.trim());
const SECONDARY_PAIR_IDS = env.SECONDARY_PAIR_IDS.split(',').map(s => s.trim());
const SECONDARY_MAX_POSITION = env.SECONDARY_MAX_POSITION_USD;

export async function discoverLPEntryExit(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];
  const pairs = enabledPairs();

  // Get current block number for freshness tracking
  let currentBlockNumber = 0;
  try {
    currentBlockNumber = await provider.getBlockNumber();
  } catch (err) {
    log.warn('Failed to fetch block number, using 0', { error: String(err) });
  }

  for (const pair of pairs) {
    const isPrimary = PRIMARY_PAIR_IDS.includes(pair.id);
    const maxSizeUsd = isPrimary
      ? env.MAX_POSITION_SIZE_USD
      : Math.min(env.MAX_POSITION_SIZE_USD, SECONDARY_MAX_POSITION);

    const useEnso = env.USE_ENSO_ROUTE_PRIMARY;

    // 1. Find optimal trade size and get the buy quote
    const result = await findOptimalTradeSize(
      pair.quote,      // sell token (quote)
      pair.base,       // buy token (base)
      10,              // min size $10
      maxSizeUsd,
      nativePriceUsd,
      useEnso,
      [],              // excludeVenues
      pair.id
    );

    if (result.optimalSizeUsd <= 0 || result.bestNetProfitUsd <= 0) {
      // Log the failure with a clear reason
      if (result.bestNetProfitUsd <= 0 && result.optimalSizeUsd > 0) {
        log.debug(`📉 No profitable opportunity for ${pair.id} at any size`, {
          optimalSize: result.optimalSizeUsd,
          bestNetProfit: result.bestNetProfitUsd,
          reason: 'Net profit ≤ 0 after costs'
        });
      } else {
        log.debug(`⛔ No viable trade for ${pair.id}`, {
          reason: 'Optimizer returned no feasible size or zero profit',
          optimalSize: result.optimalSizeUsd,
          bestNetProfit: result.bestNetProfitUsd
        });
      }
      continue;
    }

    const buyQuote = result.quote;
    if (!buyQuote) {
      log.debug(`⛔ No buy quote returned for ${pair.id} at optimal size`);
      continue;
    }

    // 2. Get sell quote for the amountOut of the buy quote
    const buyAmountOut = (buyQuote as any).amountOut;
    if (!buyAmountOut) {
      log.debug(`⛔ Buy quote missing amountOut for ${pair.id}`);
      continue;
    }

    let sellQuote: any = null;
    if (useEnso) {
      sellQuote = await getEnsoRouteQuote(pair.base, pair.quote, buyAmountOut);
    } else {
      const venues = ['uniswap-v3', 'sushiswap-v2', 'quickswap-v2'];
      const quotes = await Promise.all(
        venues.map(v => getDirectDexQuote(v, pair.base, pair.quote, buyAmountOut))
      );
      const valid = quotes.filter((q): q is DirectDexQuote => q !== null);
      if (valid.length > 0) {
        sellQuote = valid.reduce((a, b) => (Number(a.amountOut) > Number(b.amountOut) ? a : b));
      }
    }

    if (!sellQuote) {
      log.debug(`⛔ No sell quote found for ${pair.id} at optimal size`);
      continue;
    }

    // 3. Compute gross profit for logging
    const startAmountHuman = Number(buyQuote.amountIn) / 10 ** pair.quote.decimals;
    const endAmountHuman = Number(sellQuote.amountOut) / 10 ** pair.quote.decimals;
    const grossProfitHuman = endAmountHuman - startAmountHuman;
    // We don't have a stable USD price here, so we can't compute USD gross profit without a live price feed.
    // We'll rely on the optimizer's net profit which already uses live prices.

    const netProfitUsd = result.bestNetProfitUsd;

    // Log the candidate even if below threshold (but we filter out below threshold)
    if (netProfitUsd <= env.DEFAULT_MIN_PROFIT_USD) {
      log.debug(`📉 Opportunity below min profit threshold for ${pair.id}`, {
        optimalSizeUsd: result.optimalSizeUsd,
        netProfitUsd: netProfitUsd.toFixed(6),
        minRequired: env.DEFAULT_MIN_PROFIT_USD,
        grossProfitHuman,
        startAmountHuman,
        endAmountHuman,
        buyVenue: useEnso ? 'enso-route' : 'direct',
        sellVenue: useEnso ? 'enso-route' : 'direct',
        block: currentBlockNumber
      });
      continue;
    }

    // 4. Build candidate (this is a real profitable opportunity)
    const candidate: OpportunityCandidate = {
      id: `lp-${pair.id}-${Date.now()}`,
      strategy: 'lpEntryExit',
      protocol: useEnso ? 'enso-route' : 'direct',
      params: {
        pairId: pair.id,
        buyQuote: buyQuote,
        sellQuote: sellQuote,
        optimalSizeUsd: result.optimalSizeUsd,
        nativePriceUsd,
        grossProfitUsd: 0, // not used
        netProfitUsd,
        blockNumber: currentBlockNumber,
      },
      estimatedGrossProfitUsd: 0,
      estimatedNetProfitUsd: netProfitUsd,
      estimatedCostUsd: 0,
      actionPlan: null,
      sourceTimestamp: Date.now(),
    };

    candidates.push(candidate);
    log.info(`✅ Found LP candidate for ${pair.id}`, {
      sizeUsd: result.optimalSizeUsd.toFixed(2),
      netProfitUsd: netProfitUsd.toFixed(6),
      buySource: useEnso ? 'enso-route' : 'direct',
      sellSource: useEnso ? 'enso-route' : 'direct',
      block: currentBlockNumber
    });
  }

  if (candidates.length === 0) {
    log.info('📭 LP Entry/Exit found 0 candidates this cycle');
  } else {
    log.info(`📦 LP Entry/Exit found ${candidates.length} candidates`);
  }
  return candidates;
}