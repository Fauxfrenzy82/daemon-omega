import { createLogger } from '../utils/logger';

const log = createLogger('standards');

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

// Cache to avoid repeated logs
let cachedStandards: string[] | null = null;

export async function getAllStandards(): Promise<string[]> {
  if (cachedStandards) return cachedStandards;
  log.info('Using hardcoded DEX standards list', { count: HARDCODED_DEX_SLUGS.length });
  cachedStandards = HARDCODED_DEX_SLUGS;
  return cachedStandards;
}

export function excludeStandards(all: string[], exclude: string[]): string[] {
  const excludeSet = new Set(exclude);
  return all.filter((s) => !excludeSet.has(s));
}