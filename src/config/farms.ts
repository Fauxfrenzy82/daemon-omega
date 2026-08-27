import { TokenInfo } from './tokens';
import { TOKENS } from './tokens';
import { createLogger } from '../utils/logger';
import { generateRewardPositions, discoverGammaFarms } from './farmDiscovery';

const log = createLogger('farms');

export interface RewardPosition {
  id: string;
  positionAddress: string;
  rewardToken: TokenInfo;
  entryToken: TokenInfo;
  protocol: string;
}

/**
 * 🔥 DYNAMIC REWARD POSITIONS
 * 
 * These are generated at runtime by discovering active Gamma farms
 * and combining with hardcoded farms (Aave, Beefy, Balancer).
 * 
 * This eliminates the need to manually update farm addresses.
 */
let cachedRewardPositions: RewardPosition[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60000; // 1 minute

/**
 * Get reward positions – auto-discovers farms on first call
 */
export async function getRewardPositions(): Promise<RewardPosition[]> {
  const now = Date.now();
  
  // Use cached positions if still fresh
  if (cachedRewardPositions && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedRewardPositions;
  }
  
  log.info('🔄 Refreshing reward positions...');
  
  try {
    const positions = await generateRewardPositions();
    cachedRewardPositions = positions;
    cacheTimestamp = now;
    return positions;
  } catch (err) {
    log.error('Failed to generate reward positions', {
      error: err instanceof Error ? err.message : String(err),
    });
    
    // Return empty array if discovery fails
    return [];
  }
}

/**
 * Clear the cache (useful for testing)
 */
export function clearFarmCache(): void {
  cachedRewardPositions = null;
  cacheTimestamp = 0;
}

// 🔥 Legacy static export for backward compatibility
// This will be populated dynamically at runtime
export let REWARD_POSITIONS: RewardPosition[] = [];

// 🔥 Initialize REWARD_POSITIONS asynchronously
// This function should be called during system startup
export async function initializeFarms(): Promise<void> {
  try {
    REWARD_POSITIONS = await getRewardPositions();
    log.info(`✅ Farms initialized: ${REWARD_POSITIONS.length} positions`, {
      farms: REWARD_POSITIONS.map(f => f.id),
    });
  } catch (err) {
    log.error('Failed to initialize farms', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}