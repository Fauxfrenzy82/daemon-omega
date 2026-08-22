import { OpportunityCandidate, ActionPlan } from '../common/opportunityCandidate';
import { FlashLoanProvider } from '../../execution/ensoBuilder';

export async function buildActionPlan(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: any; flashLoanProvider?: FlashLoanProvider }
): Promise<ActionPlan> {
  throw new Error('Classic Incentive not implemented');
}