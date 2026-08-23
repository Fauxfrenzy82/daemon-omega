import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';
import { TokenInfo } from '../../config/tokens';
import { TOKENS } from '../../config/tokens';

const log = createLogger('classicIncentiveDataSource');

/**
 * QuickSwap V3 Subgraph endpoint.
 * Source: https://api.thegraph.com/subgraphs/name/sameepsi/quickswap-v3[reference:10]
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
  poolAddress: string;
}

interface SubgraphResponse {
  data?: {
    incentives?: Array<{
      id: string;
      rewardToken: string;
      bonusRewardToken: string;
      totalReward: string;
      bonusReward: string;
      startTime: string;
      endTime: string;
      pool: {
        id: string;
        token0: { id: string; symbol: string; decimals: string };
        token1: { id: string; symbol: string; decimals: string };
      };
    }>;
  };
  errors?: Array<{ message: string }>;
}

/**
 * Fetch active incentive programs from QuickSwap V3 subgraph.
 * These are one-time incentive programs that can be captured atomically.
 */
export async function fetchActiveIncentives(limit: number = 20): Promise<IncentiveProgram[]> {
  try {
    const currentTimestamp = Math.floor(Date.now() / 1000);

    const query = `{
      incentives(
        where: { endTime_gt: "${currentTimestamp}" }
        first: ${limit}
        orderBy: endTime
        orderDirection: asc
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
        signal: AbortSignal.timeout(10000),
      }),
      { label: 'classicIncentive.subgraph', shouldRetry: isTransientError, retries: 2 }
    );

    if (!response.ok) {
      throw new Error(`Subgraph request failed: ${response.status}`);
    }

    const data = (await response.json()) as SubgraphResponse;
    if (data.errors) {
      throw new Error(`Subgraph errors: ${JSON.stringify(data.errors)}`);
    }

    const incentives = data.data?.incentives || [];
    log.debug(`Fetched ${incentives.length} active incentives from QuickSwap subgraph`);

    return incentives.map((inc: any) => {
      // Try to map reward token to known token
      const rewardTokenAddress = inc.rewardToken.toLowerCase();
      let rewardToken = TOKENS.QUICK; // default
      let entryToken = TOKENS.USDC; // default

      // Try to find matching token
      for (const [symbol, token] of Object.entries(TOKENS)) {
        if (token.address.toLowerCase() === rewardTokenAddress) {
          rewardToken = token;
          break;
        }
      }

      // Entry token is typically the pool's token0 or token1
      if (inc.pool?.token0) {
        for (const [symbol, token] of Object.entries(TOKENS)) {
          if (token.address.toLowerCase() === inc.pool.token0.id.toLowerCase()) {
            entryToken = token;
            break;
          }
        }
      }

      return {
        id: inc.id,
        rewardToken: rewardToken,
        entryToken: entryToken,
        totalReward: inc.totalReward,
        remainingReward: inc.totalReward, // Simplified; would need to compute remaining
        startTime: Number(inc.startTime),
        endTime: Number(inc.endTime),
        poolAddress: inc.pool?.id || '',
      };
    });
  } catch (err) {
    log.error('Failed to fetch active incentives from QuickSwap subgraph', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}