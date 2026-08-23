import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('debtPositionDataSource');

/**
 * Aave V3 Polygon Subgraph endpoint.
 * Verified: https://api.thegraph.com/subgraphs/name/aave/protocol-v3-polygon
 */
const AAVE_SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-polygon';

export interface LiquidatableUser {
  id: string;
  healthFactor: string;
  totalCollateralUSD: string;
  totalDebtUSD: string;
}

/**
 * Subgraph response shape for users query.
 */
interface SubgraphResponse {
  data?: {
    users?: Array<{
      id: string;
      healthFactor: string;
      totalCollateralUSD: string;
      totalDebtUSD: string;
    }>;
  };
  errors?: Array<{ message: string }>;
}

/**
 * Fetch users with health factor < 1 from the Aave V3 Polygon subgraph.
 * Returns an array of user addresses (ids).
 */
export async function fetchLiquidatableUsers(limit: number = 100): Promise<string[]> {
  try {
    const query = `{
      users(where: { healthFactor_lt: "1" }, first: ${limit}) {
        id
        healthFactor
        totalCollateralUSD
        totalDebtUSD
      }
    }`;

    const response = await withRetry(
      () => fetch(AAVE_SUBGRAPH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      }),
      { label: 'debtPosition.subgraph', shouldRetry: isTransientError, retries: 2 }
    );

    if (!response.ok) {
      throw new Error(`Subgraph request failed: ${response.status}`);
    }

    const data = (await response.json()) as SubgraphResponse;

    if (data.errors) {
      throw new Error(`Subgraph errors: ${JSON.stringify(data.errors)}`);
    }

    const users = data.data?.users || [];
    log.debug(`Fetched ${users.length} liquidatable users from Aave subgraph`);
    return users.map((u) => u.id);
  } catch (err) {
    log.error('Failed to fetch liquidatable users from Aave subgraph', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Fetch detailed liquidatable users with full data.
 */
export async function fetchLiquidatableUsersDetailed(limit: number = 100): Promise<LiquidatableUser[]> {
  try {
    const query = `{
      users(where: { healthFactor_lt: "1" }, first: ${limit}) {
        id
        healthFactor
        totalCollateralUSD
        totalDebtUSD
      }
    }`;

    const response = await withRetry(
      () => fetch(AAVE_SUBGRAPH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      }),
      { label: 'debtPosition.subgraph.detailed', shouldRetry: isTransientError, retries: 2 }
    );

    if (!response.ok) {
      throw new Error(`Subgraph request failed: ${response.status}`);
    }

    const data = (await response.json()) as SubgraphResponse;

    if (data.errors) {
      throw new Error(`Subgraph errors: ${JSON.stringify(data.errors)}`);
    }

    const users = data.data?.users || [];
    log.debug(`Fetched ${users.length} detailed liquidatable users`);
    return users;
  } catch (err) {
    log.error('Failed to fetch detailed liquidatable users', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}