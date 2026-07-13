import { SpreadOpportunity } from './spreadCalculator';
import { createLogger } from '../utils/logger';

const log = createLogger('executionCapability');

/**
 * Execution provider map.
 * If a source is not executable, we will re-quote it using an executable source.
 */
const EXECUTION_PROVIDERS: Record<string, boolean> = {
  'paraswap-v5': true,     // ✅ Can execute trades
  'paraswapv5': true,      // Alias
  'openoceanv2': false,    // ❌ Cannot execute trades on Polygon (will re-quote)
  '1inch-v5': false,       // ❌ Not yet implemented
  'oneinchv5': false,      // ❌ Not yet implemented
};

/**
 * Result of execution validation.
 */
export interface ExecutionValidationResult {
  executable: boolean;
  requiresRequote: boolean;
  buySource: string;
  sellSource: string;
  buyRequiresRequote: boolean;
  sellRequiresRequote: boolean;
  reason?: string;
}

/**
 * Validates a spread opportunity and determines if re-quoting is needed.
 * 
 * Rules:
 * - If buySource is not executable → mark buyRequiresRequote = true
 * - If sellSource is not executable → mark sellRequiresRequote = true
 * - Returns executable: true if at least one leg is executable
 * - The execution layer will re-quote non-executable legs
 */
export function validateExecutionCapability(spread: SpreadOpportunity): ExecutionValidationResult {
  const buySource = spread.buySource;
  const sellSource = spread.sellSource;

  const buyIsExecutable = EXECUTION_PROVIDERS[buySource] === true;
  const sellIsExecutable = EXECUTION_PROVIDERS[sellSource] === true;

  const buyRequiresRequote = !buyIsExecutable;
  const sellRequiresRequote = !sellIsExecutable;

  // If both legs require re-quote, we need to re-quote both
  // If neither leg is executable, we cannot execute this opportunity
  if (buyRequiresRequote && sellRequiresRequote) {
    const reason = `Both buy and sell sources are quote-only: ${buySource} and ${sellSource}`;
    log.debug(`Opportunity rejected: ${reason}`);
    return {
      executable: false,
      requiresRequote: true,
      buySource,
      sellSource,
      buyRequiresRequote: true,
      sellRequiresRequote: true,
      reason,
    };
  }

  log.debug(`Opportunity validation: ${buySource}${buyRequiresRequote ? ' (requote)' : ' ✅'} → ${sellSource}${sellRequiresRequote ? ' (requote)' : ' ✅'}`);

  return {
    executable: true,
    requiresRequote: buyRequiresRequote || sellRequiresRequote,
    buySource,
    sellSource,
    buyRequiresRequote,
    sellRequiresRequote,
  };
}

/**
 * Returns the list of sources that support execution.
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