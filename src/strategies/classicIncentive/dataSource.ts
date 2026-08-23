import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';
import { TokenInfo } from '../../config/tokens';
import { TOKENS } from '../../config/tokens';

const log = createLogger('classicIncentiveDataSource');

/**
 * QuickSwap V3 Subgraph endpoints.
 * 
 * Correct subgraph ID: 5AK9Y4tk27ZWrPKvSAUQmffXWyQvjWqyJ2GNEZUWTirU
 * 
 * Sources:
 * - https://thegraph.com/explorer/subgraphs/5AK9Y4tk27ZWrPKvSAUQmffXWyQvjWqyJ2GNEZUWTirU
 * - https://github.com/sameepsi/quickswap-v3-subgraph
 * 
 * The decentralized network requires a valid API key from The Graph Studio.
 * Set SUBGRAPH_API_KEY in your environment variables.
 * 
 * The hosted endpoint (api.thegraph.com/subgraphs/name/sameepsi/quickswap-v3)
 * is deprecated and no longer reliable. Use the decentralized gateway instead.
 */
const SUBGRAPH_API_KEY = process.env.SUBGRAPH_API_KEY || '';
const QUICKSWAP_V3_ENDPOINTS = [
  // Decentralized network with API key (preferred)
  SUBGRAPH_API_KEY ? `https://gateway.thegraph.com/api/${SUBGRAPH_API_KEY}/subgraphs/id/5AK9Y4tk27ZWrPKvSAUQmffXWyQvjWqyJ2GNEZUWTirU` : null,
  // Studio hosted endpoint (alternative)
  'https://api.studio.thegraph.com/query/23875/quickswap-v3/version/latest',
  // Fallback hosted endpoint (deprecated)
  'https://api.thegraph.com/subgraphs/name/sameepsi/quickswap-v3',
].filter(Boolean) as string[];

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

async function fetchFromEndpoint(endpoint: string, query: string): Promise<SubgraphResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return (await response.json()) as SubgraphResponse;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

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

    let lastError: Error | null = null;

    for (const endpoint of QUICKSWAP_V3_ENDPOINTS) {
      try {
        log.debug(`Attempting to fetch from: ${endpoint}`);
        const response = await withRetry(
          () => fetchFromEndpoint(endpoint, query),
          { label: `classicIncentive.subgraph.${endpoint}`, shouldRetry: isTransientError, retries: 2 }
        );

        if (response.errors) {
          throw new Error(`Subgraph errors: ${JSON.stringify(response.errors)}`);
        }

        const incentives = response.data?.incentives || [];
        if (incentives.length > 0) {
          log.debug(`Fetched ${incentives.length} active incentives from ${endpoint}`);
          return incentives.map((inc: any) => {
            const rewardTokenAddress = inc.rewardToken.toLowerCase();
            let rewardToken = TOKENS.QUICK;
            let entryToken = TOKENS.USDC;

            for (const [symbol, token] of Object.entries(TOKENS)) {
              if (token.address.toLowerCase() === rewardTokenAddress) {
                rewardToken = token;
                break;
              }
            }

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
              remainingReward: inc.totalReward,
              startTime: Number(inc.startTime),
              endTime: Number(inc.endTime),
              poolAddress: inc.pool?.id || '',
            };
          });
        }
        log.debug(`No incentives found from ${endpoint}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (lastError.message.includes('auth error') || lastError.message.includes('API key')) {
          log.warn('QuickSwap subgraph requires an API key. Set SUBGRAPH_API_KEY in environment.');
        } else {
          log.warn(`QuickSwap subgraph endpoint failed: ${lastError.message}`);
        }
        continue;
      }
    }

    if (!SUBGRAPH_API_KEY) {
      log.error('No SUBGRAPH_API_KEY set. Set it in environment to use Classic Incentive strategy.');
    }

    log.error('All QuickSwap subgraph endpoints failed', { error: lastError?.message });
    return [];
  } catch (err) {
    log.error('Failed to fetch active incentives from QuickSwap subgraph', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}