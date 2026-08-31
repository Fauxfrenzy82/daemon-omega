// src/strategies/classicIncentive/protocolRegistry.ts

import { ethers } from 'ethers';
import { TokenInfo, TOKENS } from '../../config/tokens';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';

const log = createLogger('protocolRegistry');

// ============================================
// TYPES
// ============================================

export interface HarvestFunction {
  name: string;
  signature: string;
  args?: string[];
}

export type RewardType = 
  | 'harvest-triggered'   // Caller receives value (Beefy)
  | 'keeper-incentive'    // Caller gets keeper fee (Convex)
  | 'merkl-claim'         // Merkl-distributed rewards (Gamma)
  | 'position-based'      // Rewards tied to positions (skip)
  | 'claim-with-proof';   // Merkl-style (skip)

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
  requiresPosition?: boolean; // ✅ NEW: For Merkl/Gamma
  tvlUsd?: string;
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

// Merkl distributor ABI (for Gamma rewards)
export const MERKL_ABI = [
  'function claim(bytes32[] calldata proof, bytes32[] calldata proofFlags, bytes calldata data) external',
  'function getReward(address) external',
  'function claimable(address, address) view returns (uint256)',
];

// ============================================
// ADAPTER 1: HARVEST-TRIGGERED (Beefy, Convex, Harvest)
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
    requiresPosition: false,
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
    requiresPosition: false,
  },
];

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
    requiresPosition: false,
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
    requiresPosition: false,
  },
];

// ============================================
// ADAPTER 2: MERKL-CLAIM (Gamma / QuickSwap ALM)
// ============================================

// These are NOT harvest-triggered — they require LP positions
// They are discovered dynamically from subgraph
let merklProtocols: ProtocolConfig[] = [];

export function setMerklProtocols(pools: { id: string; token0: any; token1: any; tvlUsd?: string }[]): void {
  merklProtocols = pools.map(pool => ({
    id: `merkl-${pool.id}`,
    name: `Merkl Pool ${pool.token0.symbol}/${pool.token1.symbol}`,
    priority: 1,
    address: pool.id,
    functions: [
      { name: 'getReward', signature: 'getReward(address)' },
    ],
    rewardToken: TOKENS.QUICK,
    entryToken: TOKENS.USDC,
    rewardType: 'merkl-claim',
    skipForCallerHarvest: true, // ✅ NOT harvest-triggered
    abi: MERKL_ABI,
    requiresPosition: true, // ✅ Requires LP position
    tvlUsd: pool.tvlUsd,
  }));

  log.info(`✅ Registered ${merklProtocols.length} Merkl/Gamma protocols`);
}

// ============================================
// POSITION-BASED PROTOCOLS (SKIP)
// ============================================

const POSITION_BASED_PROTOCOLS: ProtocolConfig[] = [
  {
    id: 'morpho-blue',
    name: 'Morpho Blue',
    priority: 3,
    address: env.MORPHO_ADDRESS || '',
    functions: [],
    rewardToken: TOKENS.USDC,
    entryToken: TOKENS.USDC,
    rewardType: 'position-based',
    skipForCallerHarvest: true,
    abi: [],
    requiresPosition: true,
  },
  {
    id: 'aave-v3-rewards',
    name: 'Aave V3 Rewards',
    priority: 3,
    address: '0x929EC64c34a17401F460460D4B9390518E5B473e',
    functions: [],
    rewardToken: TOKENS.AAVE,
    entryToken: TOKENS.USDC,
    rewardType: 'position-based',
    skipForCallerHarvest: true,
    abi: [],
    requiresPosition: true,
  },
];

// ============================================
// MASTER EXPORTS
// ============================================

// ✅ Harvest-triggered protocols (caller gets paid)
export const HARVESTABLE_PROTOCOLS: ProtocolConfig[] = [
  ...BEEFY_PROTOCOLS,
  ...CONVEX_PROTOCOLS,
  ...HARVEST_PROTOCOLS,
];

// ✅ All protocols (including Merkl/Gamma)
export function getAllProtocols(): ProtocolConfig[] {
  return [...HARVESTABLE_PROTOCOLS, ...merklProtocols];
}

// ✅ Only harvest-triggered (caller gets paid)
export function getHarvestableProtocols(): ProtocolConfig[] {
  const all = [...HARVESTABLE_PROTOCOLS];
  return all.filter(p => 
    !p.skipForCallerHarvest && 
    p.address && 
    p.address !== '' &&
    p.address !== ethers.constants.AddressZero
  );
}

// ✅ Merkl/Gamma protocols (require LP position)
export function getMerklProtocols(): ProtocolConfig[] {
  return merklProtocols.filter(p => 
    p.address && 
    p.address !== '' &&
    p.address !== ethers.constants.AddressZero
  );
}

// ============================================
// HELPERS
// ============================================

export function isHarvestLikeFunction(functionName: string): boolean {
  const lower = functionName.toLowerCase();
  return ['harvest', 'compound', 'earn', 'claim', 'claimRewards', 'getReward'].some(k => lower.includes(k));
}

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