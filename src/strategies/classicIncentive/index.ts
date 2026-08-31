// src/strategies/classicIncentive/index.ts

export { discoverClassicIncentive } from './discover';
export { buildActionPlan } from './buildActionPlan';
export {
  // Types
  ProtocolConfig,
  RewardType,
  
  // Constants
  HARVESTABLE_PROTOCOLS,
  BEEFY_ABI,
  CONVEX_ABI,
  MERKL_ABI,
  GAMMA_ABI,
  FARM_ABI,
  
  // Getters
  getHarvestableProtocols,
  getMerklProtocols,
  getMerklPools,
  
  // Helpers
  isHarvestable,
  isHarvestLikeFunction,
  getContractInterface,
  
  // Setters
  setMerklProtocols,
  setDiscoveredProtocols,
  
  // Factories
  createGammaProtocol,
  createFarmProtocol,
} from './protocolRegistry';