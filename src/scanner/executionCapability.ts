import { SpreadOpportunity } from './spreadCalculator';
import { createLogger } from '../utils/logger';

const log = createLogger('executionCapability');

// Only 3 protocols support execution on Polygon
const EXECUTION_PROVIDERS: Record<string, boolean> = {
  'paraswap-v5': true,
  'paraswapv5': true,
  'zeroex-v4': true,
  'zeroexv4': true,
  'uniswap-v3': true,
  'uniswapv3': true,
};

export interface ExecutionValidationResult {
  executable: boolean;
  requiresRequote: boolean;
  buySource: string;
  sellSource: string;
  buyRequiresRequote: boolean;
  sellRequiresRequote: boolean;
  reason?: string;
}

export function validateExecutionCapability(spread: SpreadOpportunity): ExecutionValidationResult {
  const buySource = spread.buySource;
  const sellSource = spread.sellSource;

  const buyIsExecutable = EXECUTION_PROVIDERS[buySource] === true;
  const sellIsExecutable = EXECUTION_PROVIDERS[sellSource] === true;

  const buyRequiresRequote = !buyIsExecutable;
  const sellRequiresRequote = !sellIsExecutable;

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

export function getExecutableSources(): string[] {
  return Object.keys(EXECUTION_PROVIDERS).filter((key) => EXECUTION_PROVIDERS[key]);
}

export function sourceSupportsExecution(source: string): boolean {
  return EXECUTION_PROVIDERS[source] === true;
}