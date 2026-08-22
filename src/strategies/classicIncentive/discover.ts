import { OpportunityCandidate } from '../common/opportunityCandidate';
import { createLogger } from '../../utils/logger';

const log = createLogger('classicIncentive');

export async function discoverClassicIncentive(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  log.info('📭 Classic Incentive strategy: Not implemented yet. Skipping.');
  log.info('💡 This strategy requires integration with incentive program data (e.g., one‑time deposit bonuses, referral incentives).');
  return [];
}