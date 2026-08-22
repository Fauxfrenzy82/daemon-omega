import { ethers } from 'ethers';
import { TokenInfo } from '../../config/tokens';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { enabledPairs } from '../../config/pairs';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';
import { findOptimalTradeSize } from '../../utils/optimizer';
import { provider } from '../../treasury/wallets';

const log = createLogger('lpEntryExit');

const PRIMARY_PAIR_IDS = env.PRIMARY_PAIR_IDS.split(',').map(s => s.trim());
const SECONDARY_PAIR_IDS = env.SECONDARY_PAIR_IDS.split(',').map(s => s.trim());
const SECONDARY_MAX_POSITION = env.SECONDARY_MAX_POSITION_USD;

export async function discoverLPEntryExit(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];
  const pairs = enabledPairs();

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

    // Optimizer returns both buy and sell quotes with net profit already computed
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
      log.debug(`No profitable opportunity for ${pair.id} at any size`, {
        optimalSize: result.optimalSizeUsd,
        bestNetProfit: result.bestNetProfitUsd
      });
      continue;
    }

    const buyQuote = result.buyQuote;
    const sellQuote = result.sellQuote;
    if (!buyQuote || !sellQuote) {
      log.debug(`Missing quote for ${pair.id} at optimal size`);
      continue;
    }

    const netProfitUsd = result.bestNetProfitUsd;

    if (netProfitUsd <= env.DEFAULT_MIN_PROFIT_USD) {
      log.debug(`Net profit ${netProfitUsd.toFixed(4)} below threshold for ${pair.id}`);
      continue;
    }

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
        netProfitUsd,
        blockNumber: currentBlockNumber,
      },
      estimatedGrossProfitUsd: netProfitUsd + result.estimatedCostUsd,
      estimatedNetProfitUsd: netProfitUsd,
      estimatedCostUsd: result.estimatedCostUsd,
      actionPlan: null,
      sourceTimestamp: Date.now(),
    };

    candidates.push(candidate);
    log.info(`✅ Found LP candidate for ${pair.id}`, {
      sizeUsd: result.optimalSizeUsd.toFixed(2),
      netProfitUsd: netProfitUsd.toFixed(6),
      buySource: useEnso ? 'enso-route' : 'direct',
      sellSource: useEnso ? 'enso-route' : 'direct',
      block: currentBlockNumber,
    });
  }

  if (candidates.length === 0) {
    log.info('📭 LP Entry/Exit found 0 candidates this cycle');
  } else {
    log.info(`📦 LP Entry/Exit found ${candidates.length} candidates`);
  }
  return candidates;
}