import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: any; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { rewardToken, entryToken, rewardAmount, positionAddress } = candidate.params;

  const flashLoanToken = options?.flashLoanToken || entryToken;
  const flashLoanAmount = '1000000000000000000'; // Minimal entry amount

  // Steps for classic incentive arbitrage:
  // 1. Flashloan entry token
  // 2. Enter position (deposit/stake) - uses positionAddress
  // 3. Claim reward (harvest)
  // 4. Sell reward token -> entry token
  // 5. Exit position (withdraw)
  // 6. Repay flashloan (auto)

  // Step 1: Enter position (deposit)
  const enterStep: ActionStep = {
    type: 'deposit',
    protocol: 'quickswap', // or appropriate protocol
    token: entryToken.address,
    amount: flashLoanAmount,
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

  // Step 4: Exit position (withdraw)
  const exitStep: ActionStep = {
    type: 'withdraw',
    protocol: 'quickswap',
    token: entryToken.address,
    amount: { useOutputOfCallAt: 1 }, // Use output of sell step? Actually need to track shares
    primaryAddress: positionAddress,
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