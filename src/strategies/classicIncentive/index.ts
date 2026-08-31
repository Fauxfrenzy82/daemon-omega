// src/strategies/classicIncentive/index.ts

export { discoverClassicIncentive } from './discover';
export { buildActionPlan } from './buildActionPlan';
export { 
  ProtocolConfig, 
  RewardType, 
  HARVESTABLE_PROTOCOLS,
  getHarvestableProtocols,
  isHarvestable,
  isHarvestLikeFunction,
  getContractInterface,
} from './protocolRegistry';