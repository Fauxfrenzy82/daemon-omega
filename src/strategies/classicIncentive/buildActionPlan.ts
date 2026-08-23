import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: any; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { rewardToken, entryToken, totalReward } = candidate.params;

  const flashLoanToken = options?.flashLoanToken || entryToken;
  const flashLoanAmount = '1000000000000000000'; // 1 token (simplified)

  // For Classic Incentive, the action is:
  // 1. Flashloan entry token
  // 2. Swap entry token -> reward token (or deposit into position)
  // 3. Claim reward (harvest)
  // 4. Swap reward token -> entry token
  // 5. Repay flashloan

  // Step 1: Swap entry token to enter the position
  // Using Enso route for the swap
  const enterStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: entryToken.address,
    tokenOut: rewardToken.address,
    amountIn: flashLoanAmount,
    slippage: '100',
  };

  // Step 2: Harvest the reward (if needed)
  const harvestStep: ActionStep = {
    type: 'harvest',
    protocol: 'enso',
    positionAddress: candidate.params.positionAddress || '',
    token: rewardToken.address,
  };

  // Step 3: Swap reward token back to entry token
  const exitStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: rewardToken.address,
    tokenOut: entryToken.address,
    amountIn: { useOutputOfCallAt: 0 }, // Use output of harvest step
    slippage: '100',
  };

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    callback: [enterStep, harvestStep, exitStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}