import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('debtPositionDataSource');

/**
 * Aave V3 Polygon Account Subgraph.
 * 
 * Subgraph ID: 6yuf1C49aWEscgk5n9D1DekeG1BCk5Z9imJYJT3sVmAT
 * 
 * This subgraph uses "Account" as the top-level entity, not "users".
 * Health factor data is on the "positions" field within Account.
 */
const SUBGRAPH_API_KEY = process.env.SUBGRAPH_API_KEY || '';
const AAVE_V3_POLYGON_SUBGRAPH_ID = '6yuf1C49aWEscgk5n9D1DekeG1BCk5Z9imJYJT3sVmAT';

const AAVE_SUBGRAPH_ENDPOINTS = [
  SUBGRAPH_API_KEY ? `https://gateway.thegraph.com/api/${SUBGRAPH_API_KEY}/subgraphs/id/${AAVE_V3_POLYGON_SUBGRAPH_ID}` : null,
  SUBGRAPH_API_KEY ? `https://gateway.thegraph.com/api/subgraphs/id/${AAVE_V3_POLYGON_SUBGRAPH_ID}` : null,
  'https://api.studio.thegraph.com/query/23875/aave-v3-polygon/version/latest',
  'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-polygon',
].filter(Boolean) as string[];

export interface LiquidatablePosition {
  accountId: string;
  healthFactor: string;
  collateralUSD: string;
  debtUSD: string;
  positionId: string;
}

interface SubgraphResponse {
  data?: {
    accounts?: Array<{
      id: string;
      positions?: Array<{
        id: string;
        healthFactor: string;
        collateralUSD: string;
        debtUSD: string;
      }>;
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
      headers: {
        'Content-Type': 'application/json',
        ...(endpoint.includes('gateway.thegraph.com/api/subgraphs/id/') && SUBGRAPH_API_KEY
          ? { 'Authorization': `Bearer ${SUBGRAPH_API_KEY}` }
          : {}),
      },
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

export async function fetchLiquidatablePositions(limit: number = 100): Promise<LiquidatablePosition[]> {
  const query = `{
    accounts(first: ${limit}) {
      id
      positions {
        id
        healthFactor
        collateralUSD
        debtUSD
      }
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

      const accounts = data.data?.accounts || [];
      const results: LiquidatablePosition[] = [];

      for (const account of accounts) {
        const positions = account.positions || [];
        for (const position of positions) {
          const healthFactor = parseFloat(position.healthFactor);
          if (healthFactor > 0 && healthFactor < 1) {
            results.push({
              accountId: account.id,
              positionId: position.id,
              healthFactor: position.healthFactor,
              collateralUSD: position.collateralUSD,
              debtUSD: position.debtUSD,
            });
          }
        }
      }

      if (results.length > 0) {
        log.debug(`Found ${results.length} liquidatable positions from ${endpoint}`);
        return results;
      }
      log.debug(`No liquidatable positions found from ${endpoint}`);
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
    log.error('No SUBGRAPH_API_KEY set. The Graph decentralized network requires an API key.');
  }

  log.error('All subgraph endpoints failed', { error: lastError?.message });
  return [];
}

export async function fetchLiquidatableUsers(limit: number = 100): Promise<string[]> {
  const positions = await fetchLiquidatablePositions(limit);
  return [...new Set(positions.map(p => p.accountId))];
}