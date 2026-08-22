import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: any; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { positionAddress, rewardToken, entryToken, rewardAmount, sellQuote } = candidate.params;

  const flashLoanToken = options?.flashLoanToken || entryToken;
  const flashLoanAmount = '1'; // minimal amount

  const harvestStep: ActionStep = {
    type: 'harvest',
    protocol: 'enso',
    positionAddress: positionAddress,
    token: rewardToken.address,
  };

  const sellStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: rewardToken.address,
    tokenOut: entryToken.address,
    amountIn: { useOutputOfCallAt: 0 },
    slippage: '100',
    primaryAddress: sellQuote?.raw?.primaryAddress || undefined,
    poolFee: sellQuote?.raw?.poolFee,
  };

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    callback: [harvestStep, sellStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}