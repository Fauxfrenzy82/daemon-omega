import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('debtPositionDataSource');

/**
 * Aave V3 Polygon Subgraph endpoint.
 * Using the official decentralized subgraph ID via The Graph's hosted service.
 */
const AAVE_SUBGRAPH_ENDPOINTS = [
  'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-polygon',
  'https://gateway.thegraph.com/api/aave/subgraphs/id/Co2URyXjnxaw8WqxKyVHdirq9Ahhmsvcts4dMedAq211',
  'https://api.studio.thegraph.com/query/23875/aave-v3-polygon/version/latest',
];

export interface LiquidatableUser {
  id: string;
  healthFactor: string;
  totalCollateralUSD: string;
  totalDebtUSD: string;
}

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

async function fetchFromEndpoint(endpoint: string, query: string): Promise<SubgraphResponse> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return (await response.json()) as SubgraphResponse;
}

export async function fetchLiquidatableUsers(limit: number = 100): Promise<string[]> {
  const query = `{
    users(where: { healthFactor_lt: "1" }, first: ${limit}) {
      id
      healthFactor
      totalCollateralUSD
      totalDebtUSD
    }
  }`;

  let lastError: Error | null = null;

  for (const endpoint of AAVE_SUBGRAPH_ENDPOINTS) {
    try {
      const data = await withRetry(
        () => fetchFromEndpoint(endpoint, query),
        { label: `debtPosition.subgraph.${endpoint}`, shouldRetry: isTransientError, retries: 2 }
      );

      if (data.errors) {
        throw new Error(`Subgraph errors: ${JSON.stringify(data.errors)}`);
      }

      const users = data.data?.users || [];
      log.debug(`Fetched ${users.length} liquidatable users from ${endpoint}`);
      return users.map(u => u.id);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn(`Subgraph endpoint ${endpoint} failed: ${lastError.message}`);
      continue;
    }
  }

  log.error('All subgraph endpoints failed', { error: lastError?.message });
  return [];
}

export async function fetchLiquidatableUsersDetailed(limit: number = 100): Promise<LiquidatableUser[]> {
  const query = `{
    users(where: { healthFactor_lt: "1" }, first: ${limit}) {
      id
      healthFactor
      totalCollateralUSD
      totalDebtUSD
    }
  }`;

  let lastError: Error | null = null;

  for (const endpoint of AAVE_SUBGRAPH_ENDPOINTS) {
    try {
      const data = await withRetry(
        () => fetchFromEndpoint(endpoint, query),
        { label: `debtPosition.subgraph.detailed.${endpoint}`, shouldRetry: isTransientError, retries: 2 }
      );

      if (data.errors) {
        throw new Error(`Subgraph errors: ${JSON.stringify(data.errors)}`);
      }

      const users = data.data?.users || [];
      log.debug(`Fetched ${users.length} detailed liquidatable users from ${endpoint}`);
      return users;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn(`Subgraph endpoint ${endpoint} failed: ${lastError.message}`);
      continue;
    }
  }

  log.error('All subgraph endpoints failed', { error: lastError?.message });
  return [];
}