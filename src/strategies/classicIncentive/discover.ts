import { OpportunityCandidate } from '../common/opportunityCandidate';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';
import { fetchActiveIncentives } from './dataSource';
import { pushCandidate } from '../../execution/queue';
import { getLiveTokenPriceUsd } from '../../utils/priceUtils';

const log = createLogger('classicIncentive');

export async function discoverClassicIncentive(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  log.info('🔍 Classic Incentive discovery started');

  // Fetch active incentive programs from QuickSwap subgraph
  const incentives = await fetchActiveIncentives(20);

  if (incentives.length === 0) {
    log.info('📭 Classic Incentive: No active incentive programs found');
    return [];
  }

  for (const incentive of incentives) {
    try {
      // Get live reward token price
      const rewardPrice = await getLiveTokenPriceUsd(incentive.rewardToken);
      const rewardValue = (Number(incentive.totalReward) / 1e18) * rewardPrice;

      // Estimate costs
      const estimatedGasUsd = 0.1 * nativePriceUsd;
      const netProfitUsd = rewardValue - estimatedGasUsd;

      if (netProfitUsd > env.DEFAULT_MIN_PROFIT_USD) {
        const candidate: OpportunityCandidate = {
          id: `incentive-${incentive.id}-${Date.now()}`,
          strategy: 'classicIncentive',
          protocol: 'quickswap',
          params: {
            incentiveId: incentive.id,
            rewardToken: incentive.rewardToken,
            entryToken: incentive.entryToken,
            totalReward: incentive.totalReward,
            remainingReward: incentive.remainingReward,
            startTime: incentive.startTime,
            endTime: incentive.endTime,
            poolAddress: incentive.poolAddress,
            nativePriceUsd,
            rewardValue,
          },
          estimatedGrossProfitUsd: rewardValue,
          estimatedNetProfitUsd: netProfitUsd,
          estimatedCostUsd: rewardValue - netProfitUsd,
          actionPlan: null,
          sourceTimestamp: Date.now(),
        };

        // STREAM: push immediately
        pushCandidate(candidate);
        candidates.push(candidate);
        log.info(`Found classic incentive candidate for ${incentive.id}`, {
          netProfitUsd: netProfitUsd.toFixed(4),
          rewardToken: incentive.rewardToken.symbol,
          rewardValue: rewardValue.toFixed(4),
        });
      } else {
        log.debug(`Incentive ${incentive.id} below profit threshold`, {
          rewardValue: rewardValue.toFixed(4),
          netProfitUsd: netProfitUsd.toFixed(6),
          threshold: env.DEFAULT_MIN_PROFIT_USD
        });
      }
    } catch (err) {
      log.debug(`Incentive check failed for ${incentive.id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info(`Classic Incentive found ${candidates.length} candidates`);
  return candidates;
}