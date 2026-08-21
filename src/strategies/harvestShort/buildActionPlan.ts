import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';

export async function buildActionPlan(candidate: OpportunityCandidate): Promise<ActionPlan> {
  const { positionAddress, rewardToken, entryToken, rewardAmount, sellQuote } = candidate.params;

  // Use entry token as flashloan (minimal amount, just to enable the bundle)
  const flashLoanToken = entryToken;
  const flashLoanAmount = '1'; // minimal wei (or 0? but Enso needs positive)

  // Steps:
  // 1. Flashloan entry token (minimal)
  // 2. Harvest reward
  // 3. Sell reward token -> entry token
  // 4. Repay flashloan (auto)

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
    amountIn: { useOutputOfCallAt: 0 }, // Use harvest output
    slippage: '100',
    primaryAddress: sellQuote?.raw?.primaryAddress || undefined,
    poolFee: sellQuote?.raw?.poolFee,
  };

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: 'aave-v3',
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