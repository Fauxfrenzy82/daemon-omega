import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('debtPositionDataSource');

/**
 * Aave V3 Polygon Subgraph.
 * 
 * Subgraph ID: 6yuf1C49aWEscgk5n9D1DekeG1BCk5Z9imJYJT3sVmAT
 * 
 * The decentralized network requires a valid API key from The Graph Studio.
 * Set SUBGRAPH_API_KEY in your environment variables.
 */
const SUBGRAPH_API_KEY = process.env.SUBGRAPH_API_KEY || '';
const AAVE_V3_POLYGON_SUBGRAPH_ID = '6yuf1C49aWEscgk5n9D1DekeG1BCk5Z9imJYJT3sVmAT';

const AAVE_SUBGRAPH_ENDPOINTS = [
  // Decentralized network with API key (preferred)
  SUBGRAPH_API_KEY ? `https://gateway.thegraph.com/api/${SUBGRAPH_API_KEY}/subgraphs/id/${AAVE_V3_POLYGON_SUBGRAPH_ID}` : null,
  // Clean URL with Authorization header (alternative)
  SUBGRAPH_API_KEY ? `https://gateway.thegraph.com/api/subgraphs/id/${AAVE_V3_POLYGON_SUBGRAPH_ID}` : null,
  // Studio hosted endpoint (alternative)
  'https://api.studio.thegraph.com/query/23875/aave-v3-polygon/version/latest',
  // Fallback hosted endpoint (deprecated)
  'https://api.thegraph.com/subgraphs/name/aave/protocol-v3-polygon',
].filter(Boolean) as string[];

export interface LiquidatableUser {
  id: string;
  healthFactor: string;
  totalCollateralUSD: string;
  totalDebtUSD: string;
}

interface SubgraphResponse {
  data?: {
    accounts?: Array<{
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

export async function fetchLiquidatableUsers(limit: number = 100): Promise<string[]> {
  // FIXED: Use "accounts" not "users" – this is the correct schema field for Aave V3
  const query = `{
    accounts(where: { healthFactor_lt: "1" }, first: ${limit}) {
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

      const accounts = data.data?.accounts || [];
      if (accounts.length > 0) {
        log.debug(`Fetched ${accounts.length} liquidatable accounts from ${endpoint}`);
        return accounts.map(u => u.id);
      }
      log.debug(`No liquidatable accounts found from ${endpoint}`);
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

export async function fetchLiquidatableUsersDetailed(limit: number = 100): Promise<LiquidatableUser[]> {
  // FIXED: Use "accounts" not "users"
  const query = `{
    accounts(where: { healthFactor_lt: "1" }, first: ${limit}) {
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

      const accounts = data.data?.accounts || [];
      if (accounts.length > 0) {
        log.debug(`Fetched ${accounts.length} detailed liquidatable accounts from ${endpoint}`);
        return accounts;
      }
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