import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';
import { TokenInfo } from '../../config/tokens';

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: TokenInfo; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { rewardToken, entryToken, rewardAmount, positionAddress } = candidate.params;

  const flashLoanToken = options?.flashLoanToken || entryToken;
  const flashLoanAmount = '1000000000000000000'; // Minimal entry amount

  // Steps for classic incentive arbitrage:
  // 1. Flashloan entry token
  // 2. Enter position - use Enso route to swap into position
  // 3. Claim reward (harvest)
  // 4. Sell reward token -> entry token
  // 5. Exit position - use Enso route to swap back
  // 6. Repay flashloan (auto)

  // Step 1: Enter position via Enso route
  const enterStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: entryToken.address,
    tokenOut: rewardToken.address, // Assuming reward token is what we receive
    amountIn: flashLoanAmount,
    slippage: '100',
    primaryAddress: positionAddress,
  };

  // Step 2: Harvest the reward
  const harvestStep: ActionStep = {
    type: 'harvest',
    protocol: 'enso',
    positionAddress: positionAddress,
    token: rewardToken.address,
  };

  // Step 3: Sell reward token back to entry token
  const sellStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: rewardToken.address,
    tokenOut: entryToken.address,
    amountIn: { useOutputOfCallAt: 0 }, // Use harvest output
    slippage: '100',
  };

  // Step 4: Exit position via Enso route
  const exitStep: ActionStep = {
    type: 'swap',
    protocol: 'enso',
    tokenIn: rewardToken.address,
    tokenOut: entryToken.address,
    amountIn: { useOutputOfCallAt: 1 }, // Use output of sell step
    slippage: '100',
  };

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    callback: [enterStep, harvestStep, sellStep, exitStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}