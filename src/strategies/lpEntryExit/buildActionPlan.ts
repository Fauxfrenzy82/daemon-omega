import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: any; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { buyQuote, sellQuote, amountInRaw } = candidate.params;
  const quoteToken = buyQuote.tokenIn;
  const baseToken = buyQuote.tokenOut;

  // Use the provided flashloan token if given, otherwise default to quote token
  const flashLoanToken = options?.flashLoanToken || quoteToken;
  const flashLoanAmount = amountInRaw; // same amount

  // Build steps:
  // Step 0: Flashloan (callback contains the rest)
  // Step 1: Buy base with quote (swap)
  // Step 2: Sell base back to quote (swap)
  // Flashloan auto-repays

  const buyStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: quoteToken.address,
    tokenOut: baseToken.address,
    amountIn: flashLoanAmount,
    slippage: '100',
    primaryAddress: buyQuote.raw?.primaryAddress || undefined,
    poolFee: buyQuote.raw?.poolFee,
  };

  const sellStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: baseToken.address,
    tokenOut: quoteToken.address,
    amountIn: { useOutputOfCallAt: 0 }, // Use output of buy step
    slippage: '100',
    primaryAddress: sellQuote.raw?.primaryAddress || undefined,
    poolFee: sellQuote.raw?.poolFee,
  };

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    callback: [buyStep, sellStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}