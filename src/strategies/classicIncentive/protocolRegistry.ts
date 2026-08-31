// src/strategies/classicIncentive/protocolRegistry.ts

import { ethers } from 'ethers';
import { TokenInfo, TOKENS } from '../../config/tokens';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';

const log = createLogger('protocolRegistry');

// ============================================
// TYPES (Now exported for use in other files)
// ============================================

export interface HarvestFunction {
  name: string;
  signature: string;
  args?: string[];
}

export type RewardType = 
  | 'harvest-triggered'
  | 'keeper-incentive'
  | 'position-based'
  | 'claim-with-proof';

export interface ProtocolConfig {
  id: string;
  name: string;
  priority: 1 | 2 | 3;
  address: string;
  functions: HarvestFunction[];
  rewardToken: TokenInfo;
  entryToken: TokenInfo;
  rewardType: RewardType;
  callerIncentiveBps?: number;
  skipForCallerHarvest: boolean;
  abi?: string[];
}

// ============================================
// ABIs
// ============================================

export const BEEFY_ABI = [
  'function harvest() external',
  'function getReward() external',
  'function balanceOf(address) view returns (uint256)',
  'function earned(address) view returns (uint256)',
  'function strategy() view returns (address)',
  'function performanceFee() view returns (uint256)',
];

export const GAMMA_ABI = [
  'function getReward() external',
  'function harvest() external',
  'function compound() external',
  'function earned(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
];

export const FARM_ABI = [
  'function getReward() external',
  'function pendingReward(uint256, address) view returns (uint256)',
  'function userInfo(uint256, address) view returns (uint256, uint256)',
];

export const CONVEX_ABI = [
  'function getReward() external',
  'function claim() external',
  'function earned(address) view returns (uint256)',
  'function rewardRate() view returns (uint256)',
];

export const HARVEST_ABI = [
  'function harvest() external',
  'function earned(address) view returns (uint256)',
  'function getReward() external',
  'function profitSharingNumerator() view returns (uint256)',
];

// ============================================
// HARVESTABLE PROTOCOLS (Priority 1)
// ============================================

const BEEFY_PROTOCOLS: ProtocolConfig[] = [
  {
    id: 'beefy-wbtc-wmatic',
    name: 'Beefy WBTC/WMATIC Vault',
    priority: 1,
    address: env.BEEFY_VAULT_ADDRESS || '',
    functions: [
      { name: 'harvest', signature: 'harvest()' },
      { name: 'getReward', signature: 'getReward()' },
    ],
    rewardToken: TOKENS.WBTC,
    entryToken: TOKENS.USDC,
    rewardType: 'harvest-triggered',
    callerIncentiveBps: 200,
    skipForCallerHarvest: false,
    abi: BEEFY_ABI,
  },
  {
    id: 'beefy-weth-usdc',
    name: 'Beefy WETH/USDC Vault',
    priority: 1,
    address: env.BEEFY_WETH_VAULT || '',
    functions: [
      { name: 'harvest', signature: 'harvest()' },
      { name: 'getReward', signature: 'getReward()' },
    ],
    rewardToken: TOKENS.WETH,
    entryToken: TOKENS.USDC,
    rewardType: 'harvest-triggered',
    callerIncentiveBps: 200,
    skipForCallerHarvest: false,
    abi: BEEFY_ABI,
  },
];

// ============================================
// HARVESTABLE PROTOCOLS (Priority 2)
// ============================================

const CONVEX_PROTOCOLS: ProtocolConfig[] = [
  {
    id: 'convex-rewards',
    name: 'Convex Rewards',
    priority: 2,
    address: env.CONVEX_ADDRESS || '',
    functions: [
      { name: 'getReward', signature: 'getReward()' },
      { name: 'claim', signature: 'claim()' },
    ],
    rewardToken: TOKENS.USDC,
    entryToken: TOKENS.USDC,
    rewardType: 'keeper-incentive',
    skipForCallerHarvest: false,
    abi: CONVEX_ABI,
  },
];

const HARVEST_PROTOCOLS: ProtocolConfig[] = [
  {
    id: 'harvest-finance',
    name: 'Harvest Finance Vault',
    priority: 2,
    address: env.HARVEST_VAULT_ADDRESS || '',
    functions: [
      { name: 'harvest', signature: 'harvest()' },
      { name: 'getReward', signature: 'getReward()' },
    ],
    rewardToken: TOKENS.USDC,
    entryToken: TOKENS.USDC,
    rewardType: 'keeper-incentive',
    skipForCallerHarvest: false,
    abi: HARVEST_ABI,
  },
];

// ============================================
// POSITION-BASED PROTOCOLS (SKIP)
// ============================================

const POSITION_BASED_PROTOCOLS: ProtocolConfig[] = [
  {
    id: 'morpho-blue',
    name: 'Morpho Blue',
    priority: 3,
    address: env.MORPHO_ADDRESS || '',
    functions: [
      { name: 'claimRewards', signature: 'claimRewards()' },
      { name: 'withdraw', signature: 'withdraw(address,address,uint256)' },
    ],
    rewardToken: TOKENS.USDC,
    entryToken: TOKENS.USDC,
    rewardType: 'position-based',
    skipForCallerHarvest: true,
    abi: [],
  },
  {
    id: 'aave-v3-rewards',
    name: 'Aave V3 Rewards',
    priority: 3,
    address: '0x929EC64c34a17401F460460D4B9390518E5B473e',
    functions: [
      { name: 'claimAllRewards', signature: 'claimAllRewards(address[],address)' },
    ],
    rewardToken: TOKENS.AAVE,
    entryToken: TOKENS.USDC,
    rewardType: 'position-based',
    skipForCallerHarvest: true,
    abi: [],
  },
  {
    id: 'balancer-gauge',
    name: 'Balancer Gauge',
    priority: 2,
    address: env.BALANCER_GAUGE_ADDRESS || '',
    functions: [
      { name: 'claim_rewards', signature: 'claim_rewards()' },
      { name: 'getReward', signature: 'getReward(address)' },
    ],
    rewardToken: TOKENS.WMATIC,
    entryToken: TOKENS.USDC,
    rewardType: 'position-based',
    skipForCallerHarvest: true,
    abi: [],
  },
  {
    id: 'curve-gauge',
    name: 'Curve Gauge',
    priority: 2,
    address: env.CURVE_GAUGE_ADDRESS || '',
    functions: [
      { name: 'claim_rewards', signature: 'claim_rewards()' },
    ],
    rewardToken: TOKENS.USDC,
    entryToken: TOKENS.USDC,
    rewardType: 'position-based',
    skipForCallerHarvest: true,
    abi: [],
  },
  {
    id: 'merkl-distributor',
    name: 'Merkl Distributor',
    priority: 2,
    address: env.MERKL_ADDRESS || '',
    functions: [
      { name: 'claim', signature: 'claim(bytes32[],bytes32[],bytes)' },
    ],
    rewardToken: TOKENS.USDC,
    entryToken: TOKENS.USDC,
    rewardType: 'claim-with-proof',
    skipForCallerHarvest: true,
    abi: [],
  },
];

// ============================================
// DYNAMIC PROTOCOL FACTORIES
// ============================================

export function createGammaProtocol(
  pairId: string,
  address: string,
  rewardToken: TokenInfo,
  entryToken: TokenInfo
): ProtocolConfig {
  return {
    id: `quickswap-gamma-${pairId.toLowerCase()}`,
    name: `QuickSwap Gamma ${pairId}`,
    priority: 1,
    address: address,
    functions: [
      { name: 'getReward', signature: 'getReward()' },
      { name: 'harvest', signature: 'harvest()' },
      { name: 'compound', signature: 'compound()' },
    ],
    rewardToken: rewardToken,
    entryToken: entryToken,
    rewardType: 'harvest-triggered',
    skipForCallerHarvest: false,
    abi: GAMMA_ABI,
  };
}

export function createFarmProtocol(
  poolId: string,
  address: string,
  rewardToken: TokenInfo,
  entryToken: TokenInfo
): ProtocolConfig {
  return {
    id: `quickswap-farm-${poolId.toLowerCase()}`,
    name: `QuickSwap Farm ${poolId}`,
    priority: 1,
    address: address,
    functions: [
      { name: 'getReward', signature: 'getReward()' },
      { name: 'harvest', signature: 'harvest()' },
    ],
    rewardToken: rewardToken,
    entryToken: entryToken,
    rewardType: 'harvest-triggered',
    skipForCallerHarvest: false,
    abi: FARM_ABI,
  };
}

// ============================================
// MASTER PROTOCOL REGISTRY
// ============================================

export const HARVESTABLE_PROTOCOLS: ProtocolConfig[] = [
  ...BEEFY_PROTOCOLS,
  ...CONVEX_PROTOCOLS,
  ...HARVEST_PROTOCOLS,
];

// ============================================
// DISCOVERED PROTOCOLS (set at runtime)
// ============================================

let discoveredProtocols: ProtocolConfig[] = [];

export function setDiscoveredProtocols(protocols: ProtocolConfig[]): void {
  discoveredProtocols = protocols;
  log.info(`✅ Registered ${protocols.length} discovered protocols`);
}

export function getDiscoveredProtocols(): ProtocolConfig[] {
  return discoveredProtocols;
}

// ============================================
// HELPERS
// ============================================

export function getHarvestableProtocols(): ProtocolConfig[] {
  const all = [...HARVESTABLE_PROTOCOLS, ...discoveredProtocols];
  return all.filter(p => 
    !p.skipForCallerHarvest && 
    ethers.utils.isAddress(p.address) &&
    p.address !== ethers.constants.AddressZero
  );
}

export function getProtocolsByPriority(priority: 1 | 2 | 3): ProtocolConfig[] {
  return getHarvestableProtocols().filter(p => p.priority === priority);
}

export function isHarvestable(protocol: ProtocolConfig): boolean {
  return !protocol.skipForCallerHarvest && 
    (protocol.rewardType === 'harvest-triggered' || protocol.rewardType === 'keeper-incentive');
}

// ============================================
// HARVEST FUNCTION DETECTION
// ============================================

const HARVEST_KEYWORDS = [
  'harvest', 'compound', 'earn', 'claim', 'claimRewards',
  'getReward', 'updateReward', 'withdrawRewards', 'process',
  'tend', 'reinvest', 'collect', 'gather',
];

export function isHarvestLikeFunction(functionName: string): boolean {
  const lower = functionName.toLowerCase();
  return HARVEST_KEYWORDS.some(keyword => lower.includes(keyword));
}

// ============================================
// CONTRACT INTERFACE
// ============================================

export function getContractInterface(protocol: ProtocolConfig): ethers.utils.Interface {
  if (protocol.abi && protocol.abi.length > 0) {
    return new ethers.utils.Interface(protocol.abi);
  }
  const abi = protocol.functions.map(f => ({
    type: 'function',
    name: f.name,
    inputs: f.args?.map(arg => ({ type: 'address', name: arg })) || [],
    outputs: [{ type: 'uint256', name: 'amount' }],
    stateMutability: 'view',
  }));
  return new ethers.utils.Interface(abi);
}