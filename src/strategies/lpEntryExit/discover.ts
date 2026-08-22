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

/**
 * Discover LP entry/exit arbitrage opportunities using liquidity-aware optimal sizing.
 * Uses Enso route as primary quote source, falls back to direct DEX queries if configured.
 */
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
      [],              // excludeVenues (none for now)
      pair.id
    );

    if (result.optimalSizeUsd <= 0 || result.bestNetProfitUsd <= 0) {
      log.debug(`No profitable opportunity for ${pair.id} at any size`);
      continue;
    }

    const buyQuote = result.quote;
    if (!buyQuote) {
      log.debug(`No buy quote returned for ${pair.id} at optimal size`);
      continue;
    }

    // 2. Get sell quote for the amountOut of the buy quote
    const buyAmountOut = (buyQuote as any).amountOut;
    if (!buyAmountOut) {
      log.debug(`Buy quote missing amountOut for ${pair.id}`);
      continue;
    }

    let sellQuote: any = null; // Explicitly type as any to avoid type conflicts
    if (useEnso) {
      sellQuote = await getEnsoRouteQuote(pair.base, pair.quote, buyAmountOut);
    } else {
      const venues = ['uniswap-v3', 'sushiswap-v2', 'quickswap-v2'];
      const quotes = await Promise.all(
        venues.map(v => getDirectDexQuote(v, pair.base, pair.quote, buyAmountOut))
      );
      // Filter out nulls and cast to DirectDexQuote[] explicitly
      const valid = quotes.filter((q): q is DirectDexQuote => q !== null);
      if (valid.length > 0) {
        sellQuote = valid.reduce((a, b) => (Number(a.amountOut) > Number(b.amountOut) ? a : b));
      }
    }

    if (!sellQuote) {
      log.debug(`No sell quote found for ${pair.id} at optimal size`);
      continue;
    }

    // 3. Compute gross profit (for logging only; net profit from optimizer is authoritative)
    const startAmountHuman = Number(buyQuote.amountIn) / 10 ** pair.quote.decimals;
    const endAmountHuman = Number(sellQuote.amountOut) / 10 ** pair.quote.decimals;
    const grossProfitHuman = endAmountHuman - startAmountHuman;
    // Gross profit in USD is not needed for decision; the optimizer already computed it internally.

    // Use the optimizer's net profit directly
    const netProfitUsd = result.bestNetProfitUsd;

    if (netProfitUsd <= env.DEFAULT_MIN_PROFIT_USD) {
      log.debug(`Net profit ${netProfitUsd.toFixed(4)} below threshold for ${pair.id}`);
      continue;
    }

    // 4. Build candidate
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
        grossProfitUsd: grossProfitHuman * 1.0, // placeholder, not used for profitability
        netProfitUsd,
        blockNumber: currentBlockNumber,
      },
      // These fields are used for logging and thresholds; use optimizer's net profit
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