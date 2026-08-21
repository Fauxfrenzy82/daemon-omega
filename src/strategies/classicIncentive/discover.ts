import { OpportunityCandidate } from '../common/opportunityCandidate';
import { createLogger } from '../../utils/logger';

const log = createLogger('classicIncentive');

export async function discoverClassicIncentive(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  // For v1, we don't have concrete data; returning empty.
  // In future, this would query incentive programs with instant-claim bonuses.
  log.debug('Classic Incentive strategy not yet implemented');
  return [];
}