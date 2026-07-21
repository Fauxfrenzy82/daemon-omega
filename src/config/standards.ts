import { createLogger } from '../utils/logger';

const log = createLogger('standards');

/**
 * Hardcoded list of DEX protocol slugs that are known to work
 * with Enso's `getRouteData` and `ignoreStandards`.
 * These were verified in previous tests (slug test).
 */
const HARDCODED_DEX_SLUGS = [
  'uniswap-v3',
  'sushiswap-v2',
  'sushiswap-v3',
  'balancer-v2',
  'balancer-v3',
  'kyberswap',
  'ramses-v3',
  'dodo-v2',
  'woofi-v2',
  'curve',
];

/**
 * Returns the hardcoded list of DEX slugs.
 * No API call is made – this is reliable and fast.
 */
export async function getAllStandards(): Promise<string[]> {
  log.info('Using hardcoded DEX standards list', { count: HARDCODED_DEX_SLUGS.length });
  return HARDCODED_DEX_SLUGS;
}

/**
 * Exclude a set of standards from the full list.
 */
export function excludeStandards(all: string[], exclude: string[]): string[] {
  const excludeSet = new Set(exclude);
  return all.filter((s) => !excludeSet.has(s));
}