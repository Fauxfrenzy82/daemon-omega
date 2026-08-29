// src/strategies/harvestShort/discover.ts

import { OpportunityCandidate } from '../common/opportunityCandidate';
import { TokenInfo } from '../../config/tokens';
import { createLogger } from '../../utils/logger';

const log = createLogger('harvestShortDiscover');

export interface HarvestFarm {
  id: string;
  positionAddress: string;
  rewardToken: TokenInfo;
  entryToken: TokenInfo;
  protocol: string;
}

/**
 * Discovers harvest opportunities from configured farms.
 */
export async function discoverHarvestShort(
  farms: HarvestFarm[]
): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  for (const farm of farms) {
    // In a real implementation, you would:
    // 1. Query the position to get the claimable reward amount
    // 2. Check if the reward value exceeds gas costs
    // 3. Create a candidate if profitable

    log.info('📊 Checking farm for harvest opportunity', {
      id: farm.id,
      rewardToken: farm.rewardToken.symbol,
      entryToken: farm.entryToken.symbol,
      positionAddress: farm.positionAddress,
      protocol: farm.protocol,
    });

    // Placeholder: In production, fetch actual reward amount from on-chain
    const rewardAmount = '1000000000000000000'; // 1 token (placeholder)

    // Create a candidate
    const candidate: OpportunityCandidate = {
      id: `harvest-${farm.id}-${Date.now()}`,
      strategy: 'harvestShort',
      protocol: farm.protocol,
      params: {
        farm: farm,
        rewardAmount: rewardAmount,
        entryToken: farm.entryToken,
      },
      estimatedGrossProfitUsd: 1.0, // Placeholder
      estimatedNetProfitUsd: 0.5,   // Placeholder
      estimatedCostUsd: 0.5,
      actionPlan: null,
      sourceTimestamp: Date.now(),
    };

    candidates.push(candidate);
  }

  log.info(`📊 Harvest + Spot Sell found ${candidates.length} candidates`);

  return candidates;
}

// ✅ Alias for backward compatibility
export const discoverHarvestOpportunities = discoverHarvestShort;