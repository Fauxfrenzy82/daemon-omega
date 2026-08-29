// src/strategies/harvestShort/discover.ts

import { OpportunityCandidate } from '../common/opportunityCandidate';
import { TokenInfo } from '../../config/tokens';
import { activeChain } from '../../config/chains';
import { createLogger } from '../../utils/logger';

const log = createLogger('harvestShortDiscover');

export interface HarvestFarm {
  id: string;
  positionAddress: string;
  rewardToken: TokenInfo;
  entryToken: TokenInfo;
  protocol: string;
}

// ✅ Global farms configuration
const FARMS: HarvestFarm[] = [
  {
    id: 'aave-rewards',
    positionAddress: '0x5f4d15d761528c57a5c30c43c1dab26fc5452731',
    rewardToken: {
      chainId: 137,
      address: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B',
      decimals: 18,
      symbol: 'AAVE',
      name: 'Aave Token'
    },
    entryToken: {
      chainId: 137,
      address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      decimals: 6,
      symbol: 'USDC',
      name: 'USD Coin'
    },
    protocol: 'aave'
  }
];

/**
 * Discovers harvest opportunities from configured farms.
 * @param chainId - The chain ID to discover opportunities on (unused, kept for compatibility)
 */
export async function discoverHarvestShort(
  chainId?: number
): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  for (const farm of FARMS) {
    log.info('📊 Checking farm for harvest opportunity', {
      id: farm.id,
      rewardToken: farm.rewardToken.symbol,
      entryToken: farm.entryToken.symbol,
      positionAddress: farm.positionAddress,
      protocol: farm.protocol,
    });

    // Placeholder: In production, fetch actual reward amount from on-chain
    const rewardAmount = '10000000000000000'; // 0.01 token (placeholder)

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
      estimatedGrossProfitUsd: 0.1,   // Placeholder
      estimatedNetProfitUsd: 0.05,    // Placeholder
      estimatedCostUsd: 0.05,
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