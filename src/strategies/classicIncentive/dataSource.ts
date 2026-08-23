import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';
import { TokenInfo } from '../../config/tokens';
import { TOKENS } from '../../config/tokens';

const log = createLogger('classicIncentiveDataSource');

/**
 * QuickSwap V3 Subgraph endpoint.
 * Verified: https://api.thegraph.com/subgraphs/name/sameepsi/quickswap-v3[reference:14]
 */
const QUICKSWAP_V3_SUBGRAPH = 'https://api.thegraph.com/subgraphs/name/sameepsi/quickswap-v3';

export interface IncentiveProgram {
  id: string;
  rewardToken: TokenInfo;
  entryToken: TokenInfo;
  totalReward: string;
  remainingReward: string;
  startTime: number;
  endTime: number;
}

/**
 * Fetch active incentive programs from QuickSwap V3 subgraph.
 * These are one-time incentive programs that can be captured atomically.
 */
export async function fetchActiveIncentives(limit: number = 20): Promise<IncentiveProgram[]> {
  try {
    const query = `{
      incentives(
        where: { endTime_gt: ${Math.floor(Date.now() / 1000)} }
        first: ${limit}
      ) {
        id
        rewardToken
        bonusRewardToken
        totalReward
        bonusReward
        startTime
        endTime
        pool {
          id
          token0 {
            id
            symbol
            decimals
          }
          token1 {
            id
            symbol
            decimals
          }
        }
      }
    }`;

    const response = await withRetry(
      () => fetch(QUICKSWAP_V3_SUBGRAPH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      }),
      { label: 'classicIncentive.subgraph', shouldRetry: isTransientError, retries: 2 }
    );

    if (!response.ok) {
      throw new Error(`Subgraph request failed: ${response.status}`);
    }

    const data = (await response.json()) as any;
    if (data.errors) {
      throw new Error(`Subgraph errors: ${JSON.stringify(data.errors)}`);
    }

    const incentives = data.data?.incentives || [];
    log.debug(`Fetched ${incentives.length} active incentives from QuickSwap subgraph`);
    return incentives.map((inc: any) => ({
      id: inc.id,
      rewardToken: TOKENS.QUICK, // Placeholder – map from token address
      entryToken: TOKENS.USDC,   // Placeholder – map from pool tokens
      totalReward: inc.totalReward,
      remainingReward: inc.totalReward, // Simplified
      startTime: Number(inc.startTime),
      endTime: Number(inc.endTime),
    }));
  } catch (err) {
    log.error('Failed to fetch active incentives', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}