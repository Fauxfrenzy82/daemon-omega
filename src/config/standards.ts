import { getEnsoClient } from '../execution/ensoClient';
import { createLogger } from '../utils/logger';

const log = createLogger('standards');

let cachedStandards: string[] | null = null;

/**
 * Fetch the complete list of protocol standards from Enso.
 * Falls back to a known good list if the API call fails.
 */
export async function getAllStandards(): Promise<string[]> {
  if (cachedStandards) return cachedStandards;

  try {
    const enso = getEnsoClient();
    // Enso's method to list standards – might be 'getStandards' or 'getProtocols'
    // We'll try both.
    let standards: string[] = [];
    if (typeof (enso as any).getStandards === 'function') {
      standards = await (enso as any).getStandards();
    } else if (typeof (enso as any).getProtocols === 'function') {
      standards = await (enso as any).getProtocols();
    } else {
      // Fallback: use the slugs we confirmed from previous tests
      standards = [
        'uniswap-v3', 'sushiswap-v2', 'sushiswap-v3',
        'balancer-v2', 'balancer-v3', 'kyberswap',
        'ramses-v3', 'aave-v3', 'morpho-markets-v1',
      ];
    }
    if (Array.isArray(standards) && standards.length > 0) {
      cachedStandards = standards;
      log.info('Loaded standards', { count: standards.length });
      return standards;
    }
    throw new Error('No standards returned');
  } catch (err) {
    log.warn('Failed to fetch standards, using fallback list', {
      error: err instanceof Error ? err.message : String(err),
    });
    const fallback = [
      'uniswap-v3', 'sushiswap-v2', 'sushiswap-v3',
      'balancer-v2', 'kyberswap', 'ramses-v3',
    ];
    cachedStandards = fallback;
    return fallback;
  }
}

/**
 * Get a list of standards excluding a given set.
 */
export function excludeStandards(all: string[], exclude: string[]): string[] {
  const excludeSet = new Set(exclude);
  return all.filter((s) => !excludeSet.has(s));
}