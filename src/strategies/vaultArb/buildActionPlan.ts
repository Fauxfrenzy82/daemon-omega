import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';

export async function buildActionPlan(candidate: OpportunityCandidate): Promise<ActionPlan> {
  const { underlying, stataAddress, testAmount } = candidate.params;

  const flashLoanToken = underlying;
  const flashLoanAmount = testAmount;

  // Steps:
  // 1. Flashloan underlying
  // 2. Deposit underlying into StataToken (receives shares)
  // 3. Redeem shares back to underlying
  // Flashloan auto-repays

  const depositStep: ActionStep = {
    type: 'deposit',
    protocol: 'stata',
    token: underlying.address,
    amount: flashLoanAmount,
    primaryAddress: stataAddress,
  };

  const redeemStep: ActionStep = {
    type: 'withdraw',
    protocol: 'stata',
    token: underlying.address,
    amount: { useOutputOfCallAt: 0 }, // Use shares from deposit output
    primaryAddress: stataAddress,
  };

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: 'aave-v3',
    token: flashLoanToken.address,
    amount: flashLoanAmount,
    callback: [depositStep, redeemStep],
  };

  return {
    flashLoanToken,
    flashLoanAmount,
    steps: [flashloanStep],
  };
}