// src/strategies/classicIncentive/protocolRegistry.ts

import { ethers } from 'ethers';
import { TokenInfo, TOKENS } from '../../config/tokens';

// ============================================
// TYPES
// ============================================

export interface HarvestFunction {
  name: string;
  signature: string;
  args?: string[];
}

export type RewardType = 
  | 'harvest-triggered'   // Caller receives value for calling
  | 'keeper-incentive'    // Caller gets keeper fee
  | 'position-based'      // Rewards tied to positions (SKIP)
  | 'claim-with-proof';   // Merkl-style (SKIP)

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
  // Optional: custom check for pending caller reward
  checkCallerReward?: (address: string) => Promise<number>;
}

// ============================================
// ABIs
// ============================================

const BEEFY_ABI = [
  'function harvest() external',
  'function getReward() external',
  'function balanceOf(address) view returns (uint256)',
  'function earned(address) view returns (uint256)',
  'function strategy() view returns (address)',
  'function performanceFee() view returns (uint256)',
];

const GAMMA_ABI = [
  'function getReward() external',
  'function harvest() external',
  'function compound() external',
  'function earned(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
];

const FARM_ABI = [
  'function getReward() external',
  'function pendingReward(uint256, address) view returns (uint256)',
  'function userInfo(uint256, address) view returns (uint256, uint256)',
];

const CONVEX_ABI = [
  'function getReward() external',
  'function claim() external',
  'function earned(address) view returns (uint256)',
  'function rewardRate() view returns (uint256)',
];

const HARVEST_ABI = [
  'function harvest() external',
  'function earned(address) view returns (uint256)',
  'function getReward() external',
  'function profitSharingNumerator() view returns (uint256)',
];

// ============================================
// PROTOCOL REGISTRY
// ============================================

// ✅ HARVEST-TRIGGERED PROTOCOLS (CAN HARVEST)
const HARVEST_TRIGGERED: ProtocolConfig[] = [
  // 1. Beefy Finance - Caller gets performance fee share
  {
    id: 'beefy-vault',
    name: 'Beefy Finance Vault',
    priority: 1,
    address: process.env.BEEFY_VAULT_ADDRESS || '',
    functions: [
      { name: 'harvest', signature: 'harvest()' },
      { name: 'getReward', signature: 'getReward()' },
    ],
    rewardToken: TOKENS.WBTC,
    entryToken: TOKENS.USDC,
    rewardType: 'harvest-triggered',
    callerIncentiveBps: 200, // 20% of performance fee to caller
    skipForCallerHarvest: false,
    abi: BEEFY_ABI,
  },
  {
    id: 'beefy-vault-weth',
    name: 'Beefy Finance WETH Vault',
    priority: 1,
    address: process.env.BEEFY_WETH_VAULT || '',
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

// ✅ KEEPER-INCENTIVE PROTOCOLS (CAN HARVEST)
const KEEPER_INCENTIVE: ProtocolConfig[] = [
  // 2. Convex - Keeper incentives
  {
    id: 'convex-rewards',
    name: 'Convex Rewards',
    priority: 2,
    address: process.env.CONVEX_ADDRESS || '',
    functions: [
      { name: 'getReward', signature: 'getReward()' },
      { name: 'claim', signature: 'claim()' },
    ],
    rewardToken: TOKENS.CVX,
    entryToken: TOKENS.USDC,
    rewardType: 'keeper-incentive',
    skipForCallerHarvest: false,
    abi: CONVEX_ABI,
  },
  // 3. Harvest Finance - Strategy caller economics
  {
    id: 'harvest-finance',
    name: 'Harvest Finance Vault',
    priority: 2,
    address: process.env.HARVEST_VAULT_ADDRESS || '',
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

// ❌ POSITION-BASED PROTOCOLS (SKIP)
const POSITION_BASED: ProtocolConfig[] = [
  // Morpho - Rewards are position-based
  {
    id: 'morpho-blue',
    name: 'Morpho Blue',
    priority: 3,
    address: process.env.MORPHO_ADDRESS || '',
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
  // Aave V3 - Position-based rewards
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
  // Balancer Gauges - Position-based
  {
    id: 'balancer-gauge',
    name: 'Balancer Gauge',
    priority: 2,
    address: process.env.BALANCER_GAUGE_ADDRESS || '',
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
  // Curve Gauges - Position-based
  {
    id: 'curve-gauge',
    name: 'Curve Gauge',
    priority: 2,
    address: process.env.CURVE_GAUGE_ADDRESS || '',
    functions: [
      { name: 'claim_rewards', signature: 'claim_rewards()' },
    ],
    rewardToken: TOKENS.USDC,
    entryToken: TOKENS.USDC,
    rewardType: 'position-based',
    skipForCallerHarvest: true,
    abi: [],
  },
  // Merkl - Claim-with-proof (not harvestable)
  {
    id: 'merkl-distributor',
    name: 'Merkl Distributor',
    priority: 2,
    address: process.env.MERKL_ADDRESS || '',
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
// DYNAMIC PROTOCOLS (discovered at runtime)
// ============================================

// QuickSwap Gamma farms - discovered from subgraph
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

// QuickSwap Farms - permissionless reward harvesting
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
// EXPORTS
// ============================================

// All harvestable protocols (merged)
export const HARVESTABLE_PROTOCOLS: ProtocolConfig[] = [
  ...HARVEST_TRIGGERED,
  ...KEEPER_INCENTIVE,
];

// All protocols (for reference)
export const ALL_PROTOCOLS: ProtocolConfig[] = [
  ...HARVESTABLE_PROTOCOLS,
  ...POSITION_BASED,
];

// Helpers
export function getHarvestableProtocols(): ProtocolConfig[] {
  return HARVESTABLE_PROTOCOLS.filter(p => !p.skipForCallerHarvest);
}

export function getProtocolsByPriority(priority: 1 | 2 | 3): ProtocolConfig[] {
  return getHarvestableProtocols().filter(p => p.priority === priority);
}

export function isHarvestable(protocol: ProtocolConfig): boolean {
  return !protocol.skipForCallerHarvest && 
    (protocol.rewardType === 'harvest-triggered' || protocol.rewardType === 'keeper-incentive');
}

// ============================================
// HELPER: Detect harvest-like functions
// ============================================

const HARVEST_KEYWORDS = [
  'harvest',
  'compound',
  'earn',
  'claim',
  'claimRewards',
  'getReward',
  'updateReward',
  'withdrawRewards',
  'process',
  'tend',
  'reinvest',
  'collect',
  'gather',
];

export function isHarvestLikeFunction(functionName: string): boolean {
  const lower = functionName.toLowerCase();
  return HARVEST_KEYWORDS.some(keyword => lower.includes(keyword));
}

// ============================================
// HELPER: Get contract interface
// ============================================

export function getContractInterface(protocol: ProtocolConfig): ethers.utils.Interface {
  if (protocol.abi && protocol.abi.length > 0) {
    return new ethers.utils.Interface(protocol.abi);
  }
  // Build minimal interface from functions
  const abi = protocol.functions.map(f => ({
    type: 'function',
    name: f.name,
    inputs: f.args?.map(arg => ({ type: 'address', name: arg })) || [],
    outputs: [{ type: 'uint256', name: 'amount' }],
    stateMutability: 'view',
  }));
  return new ethers.utils.Interface(abi);
}