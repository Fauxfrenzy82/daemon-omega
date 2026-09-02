// src/strategies/classicIncentive/buildActionPlan.ts

import { OpportunityCandidate, ActionPlan } from '../common/opportunityCandidate';
import { createLogger } from '../../utils/logger';

const log = createLogger('buildActionPlan');

/**
 * ⚠️ TEMPORARILY DISABLED
 * Classic Incentive buildActionPlan is temporarily disabled while arbitrage is being tested.
 * To re-enable, uncomment the original implementation and remove this placeholder.
 */
export async function buildActionPlan(_candidate: OpportunityCandidate): Promise<ActionPlan> {
  log.warn('⏸️ Classic Incentive buildActionPlan is temporarily disabled');
  throw new Error('Classic Incentive strategy is temporarily disabled');
}