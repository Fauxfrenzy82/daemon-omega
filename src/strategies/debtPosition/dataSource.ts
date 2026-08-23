import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('debtPositionDataSource');

/**
 * Aave V3 Polygon Subgraph endpoints.
 * 
 * 1. The Graph hosted service (may require API key)[reference:7]
 * 2. Decentralized network using subgraph ID[reference:8]
 * 3. Alternative hosted endpoint
 * 
 * The decentralized subgraph ID for Aave V3 Polygon is:
 * Co2URyXjnxaw8WqxKyVHdirq9Ahhmsvcts4dMedAq211[reference:9]
 */
const AAVE_SUBGRAPH_ENDPOINTS = [
  // Decentralized network via The Graph's gateway (requires API key for some)
  'https://gateway.thegraph.com/api/aave/subgraphs/id/Co2URyXjnxaw8WqxKyVHdirq9Ahhmsvcts4dMedAq211',
  // Hosted service (may work without API key)
  'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-polygon',
  // Alternative hosted endpoint
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
      log.debug(`Attempting to fetch from: ${endpoint}`);
      const data = await withRetry(
        () => fetchFromEndpoint(endpoint, query),
        { label: `debtPosition.subgraph.${endpoint}`, shouldRetry: isTransientError, retries: 2 }
      );

      if (data.errors) {
        throw new Error(`Subgraph errors: ${JSON.stringify(data.errors)}`);
      }

      const users = data.data?.users || [];
      log.debug(`Fetched ${users.length} liquidatable users from ${endpoint}`);
      if (users.length > 0) {
        return users.map(u => u.id);
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn(`Subgraph endpoint failed: ${lastError.message}`);
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
      log.debug(`Attempting to fetch detailed from: ${endpoint}`);
      const data = await withRetry(
        () => fetchFromEndpoint(endpoint, query),
        { label: `debtPosition.subgraph.detailed.${endpoint}`, shouldRetry: isTransientError, retries: 2 }
      );

      if (data.errors) {
        throw new Error(`Subgraph errors: ${JSON.stringify(data.errors)}`);
      }

      const users = data.data?.users || [];
      log.debug(`Fetched ${users.length} detailed liquidatable users from ${endpoint}`);
      if (users.length > 0) {
        return users;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn(`Subgraph endpoint failed: ${lastError.message}`);
      continue;
    }
  }

  log.error('All subgraph endpoints failed', { error: lastError?.message });
  return [];
}