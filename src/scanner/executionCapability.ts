import { SpreadOpportunity } from './spreadCalculator';
import { createLogger } from '../utils/logger';

const log = createLogger('executionCapability');

/**
 * Execution provider map.
 * Add new execution providers here when they become available.
 * If a source is not listed here, it means execution is NOT supported.
 */
const EXECUTION_PROVIDERS: Record<string, boolean> = {
  'paraswap-v5': true,     // ✅ Can execute trades
  'paraswapv5': true,      // Alias
  'openoceanv2': false,    // ❌ Cannot execute trades on Polygon
  '1inch-v5': false,       // ❌ Not yet implemented
  'oneinchv5': false,      // ❌ Not yet implemented
};

/**
 * Checks if a spread opportunity is executable.
 * This is a separate check from spread discovery.
 * 
 * Requirements:
 * - The buy source must have an execution provider
 * - The sell source must have an execution provider
 * - Both must be available and implemented
 */
export function isExecutableOpportunity(spread: SpreadOpportunity): { executable: boolean; reason?: string } {
  const buySource = spread.buySource;
  const sellSource = spread.sellSource;

  // Check if buy source has an execution provider
  if (!EXECUTION_PROVIDERS[buySource]) {
    const reason = `Buy source '${buySource}' does not support execution (no provider)`;
    log.debug(`Opportunity rejected: ${reason}`);
    return { executable: false, reason };
  }

  // Check if sell source has an execution provider
  if (!EXECUTION_PROVIDERS[sellSource]) {
    const reason = `Sell source '${sellSource}' does not support execution (no provider)`;
    log.debug(`Opportunity rejected: ${reason}`);
    return { executable: false, reason };
  }

  // Check if buy and sell sources are the same (should never happen, but safety)
  if (buySource === sellSource) {
    const reason = `Buy and sell sources are the same (${buySource})`;
    log.debug(`Opportunity rejected: ${reason}`);
    return { executable: false, reason };
  }

  log.debug(`Opportunity is executable: ${buySource} → ${sellSource}`);
  return { executable: true };
}

/**
 * Returns the list of sources that support execution.
 * Used for debugging and monitoring.
 */
export function getExecutableSources(): string[] {
  return Object.keys(EXECUTION_PROVIDERS).filter((key) => EXECUTION_PROVIDERS[key]);
}

/**
 * Returns the list of sources that are quote-only (no execution).
 */
export function getQuoteOnlySources(): string[] {
  return Object.keys(EXECUTION_PROVIDERS).filter((key) => !EXECUTION_PROVIDERS[key]);
}