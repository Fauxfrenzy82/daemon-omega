import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('debtPositionDataSource');

/**
 * Aave V3 Polygon Subgraph endpoints.
 * 
 * The Graph's hosted service has been sunset, so the free endpoint is unreliable.
 * To use the decentralized network, you need an API key from The Graph Studio.
 * Set SUBGRAPH_API_KEY in your environment.
 */
const SUBGRAPH_API_KEY = process.env.SUBGRAPH_API_KEY || '';
const AAVE_SUBGRAPH_ENDPOINTS = [
  // Decentralized network with API key
  SUBGRAPH_API_KEY ? `https://gateway.thegraph.com/api/${SUBGRAPH_API_KEY}/subgraphs/id/Co2URyXjnxaw8WqxKyVHdirq9Ahhmsvcts4dMedAq211` : null,
  // Hosted service (deprecated, may fail)
  'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-polygon',
  // Alternative hosted endpoint
  'https://api.studio.thegraph.com/query/23875/aave-v3-polygon/version/latest',
].filter(Boolean) as string[];

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
      if (users.length > 0) {
        log.debug(`Fetched ${users.length} liquidatable users from ${endpoint}`);
        return users.map(u => u.id);
      }
      log.debug(`No liquidatable users found from ${endpoint}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.message.includes('auth error') || lastError.message.includes('API key')) {
        log.warn('Subgraph requires an API key. Set SUBGRAPH_API_KEY in environment.');
      } else {
        log.warn(`Subgraph endpoint failed: ${lastError.message}`);
      }
      continue;
    }
  }

  if (!SUBGRAPH_API_KEY) {
    log.error('No SUBGRAPH_API_KEY set. The Graph decentralized network requires an API key. Set it in environment to use Debt Position strategy.');
  }

  log.error('All subgraph endpoints failed', { error: lastError?.message });
  return [];
}