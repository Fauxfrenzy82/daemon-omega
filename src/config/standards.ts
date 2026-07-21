import { getEnsoClient } from '../execution/ensoClient';
import { createLogger } from '../utils/logger';

const log = createLogger('standards');

let cachedStandards: string[] | null = null;

/**
 * Fetch the complete list of protocol standards from Enso.
 * Extracts string slugs/names from the raw response.
 */
export async function getAllStandards(): Promise<string[]> {
  if (cachedStandards) return cachedStandards;

  try {
    const enso = getEnsoClient();
    let raw: any;

    if (typeof (enso as any).getStandards === 'function') {
      raw = await (enso as any).getStandards();
    } else if (typeof (enso as any).getProtocols === 'function') {
      raw = await (enso as any).getProtocols();
    } else {
      throw new Error('No method to get standards/protocols');
    }

    let standards: string[] = [];

    if (Array.isArray(raw)) {
      if (raw.length === 0) {
        throw new Error('Empty standards array');
      }
      // Check the type of the first element
      const first = raw[0];
      if (typeof first === 'string') {
        standards = raw as string[];
      } else if (typeof first === 'object' && first !== null) {
        // Try to extract a string property: slug, name, id, or label
        if (first.slug) {
          standards = raw.map((item: any) => item.slug);
        } else if (first.name) {
          standards = raw.map((item: any) => item.name);
        } else if (first.id) {
          standards = raw.map((item: any) => item.id);
        } else if (first.protocol) {
          standards = raw.map((item: any) => item.protocol);
        } else {
          // If no obvious property, fallback to using the first string-ifiable value
          // This is a fallback; we log a warning.
          log.warn('Standards objects have no known string property, using String()', {
            sample: JSON.stringify(first),
          });
          standards = raw.map((item: any) => String(item));
        }
      } else {
        // Unexpected type
        throw new Error(`Unexpected standards element type: ${typeof first}`);
      }
    } else {
      throw new Error('Standards response is not an array');
    }

    if (standards.length > 0) {
      cachedStandards = standards;
      log.info('Loaded standards', { count: standards.length });
      return standards;
    }
    throw new Error('No valid standards extracted');
  } catch (err) {
    log.warn('Failed to fetch standards, using fallback list', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Verified working DEX slugs from previous tests
    const fallback = [
      'uniswap-v3', 'sushiswap-v2', 'sushiswap-v3',
      'balancer-v2', 'kyberswap', 'ramses-v3',
    ];
    cachedStandards = fallback;
    return fallback;
  }
}

/**
 * Exclude a set of standards from the full list.
 */
export function excludeStandards(all: string[], exclude: string[]): string[] {
  const excludeSet = new Set(exclude);
  return all.filter((s) => !excludeSet.has(s));
}