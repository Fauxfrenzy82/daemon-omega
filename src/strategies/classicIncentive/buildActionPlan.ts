import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: any; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { rewardToken, entryToken, totalReward } = candidate.params;

  const flashLoanToken = options?.flashLoanToken || entryToken;
  const flashLoanAmount = '1000000000000000000'; // 1 token (simplified)

  // Steps for classic incentive arbitrage:
  // 1. Flashloan entry token
  // 2. Enter position (deposit) - receives rewards
  // 3. Claim reward
  // 4. Sell reward token -> entry token
  // 5. Exit position (withdraw)
  // 6. Repay flashloan (auto)

  const depositStep: ActionStep = {
    type: 'deposit',
    protocol: 'quickswap',
    token: entryToken.address,
    amount: flashLoanAmount,
    primaryAddress: candidate.params.positionAddress || undefined,
  };

  // For v1, we use a placeholder – this strategy needs more work
  // to properly integrate with specific incentive programs.
  // This is a simplified implementation that logs the structure.

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    callback: [depositStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}