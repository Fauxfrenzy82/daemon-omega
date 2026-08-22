import { OpportunityCandidate, ActionPlan, ActionStep } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: any; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  const { underlying, stataAddress, testAmount } = candidate.params;

  const flashLoanToken = options?.flashLoanToken || underlying;
  const flashLoanAmount = testAmount;

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
    amount: { useOutputOfCallAt: 0 },
    primaryAddress: stataAddress,
  };

  const flashloanStep: ActionStep = {
    type: 'flashloan',
    protocol: options?.flashLoanProvider?.protocol || 'aave-v3',
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