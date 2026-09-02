// src/strategies/classicIncentive/discover.ts

import { OpportunityCandidate } from '../common/opportunityCandidate';
import { createLogger } from '../../utils/logger';

const log = createLogger('classicIncentive');

/**
 * ⚠️ TEMPORARILY DISABLED
 * Classic Incentive strategy is temporarily disabled while arbitrage is being tested.
 * To re-enable, uncomment the implementation below and remove this placeholder.
 */
export async function discoverClassicIncentive(_nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  log.info('⏸️ Classic Incentive strategy is temporarily disabled');
  return [];
}