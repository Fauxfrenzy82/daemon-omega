import { OpportunityCandidate } from '../common/opportunityCandidate';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';
import { fetchActiveIncentives } from './dataSource';

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
      // For v1, we evaluate each incentive program
      const rewardValue = Number(incentive.totalReward) / 1e18; // Assuming 18 decimals
      const rewardUsd = rewardValue * 1; // Placeholder – use actual token price

      // Estimate costs
      const estimatedGasUsd = 0.1 * nativePriceUsd;
      const netProfitUsd = rewardUsd - estimatedGasUsd;

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
            nativePriceUsd,
          },
          estimatedGrossProfitUsd: rewardUsd,
          estimatedNetProfitUsd: netProfitUsd,
          estimatedCostUsd: rewardUsd - netProfitUsd,
          actionPlan: null,
          sourceTimestamp: Date.now(),
        };

        candidates.push(candidate);
        log.info(`Found classic incentive candidate for ${incentive.id}`, {
          netProfitUsd: netProfitUsd.toFixed(4),
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