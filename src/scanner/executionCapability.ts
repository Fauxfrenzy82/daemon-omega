import { SpreadOpportunity } from './spreadCalculator';
import { createLogger } from '../utils/logger';

const log = createLogger('executionCapability');

const EXECUTION_PROVIDERS: Record<string, boolean> = {
  // Reliable sources only
  'quickswap': true,
  'quickswap-v3': true,
  'balancerv2': true,
  'balancer-v2': true,
  'curve': true,
  'kyberswap': true,
  'kyber': true,

  // Disabled (broken or failing)
  'paraswap-v5': false,
  'paraswapv5': false,
  'sushiswap': false,
  'sushi-swap': false,
  'uniswapv3': false,
  'uniswap-v3': false,
  'openoceanv2': false,
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