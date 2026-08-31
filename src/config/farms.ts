// src/config/farms.ts

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

let cachedRewardPositions: RewardPosition[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60000;

export async function getRewardPositions(): Promise<RewardPosition[]> {
  const now = Date.now();
  
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
    return [];
  }
}

export function clearFarmCache(): void {
  cachedRewardPositions = null;
  cacheTimestamp = 0;
}

export let REWARD_POSITIONS: RewardPosition[] = [];

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

// ✅ Re-export discoverGammaFarms for backward compatibility
export { discoverGammaFarms };