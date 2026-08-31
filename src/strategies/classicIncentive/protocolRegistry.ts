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
  | 'harvest-triggered'
  | 'keeper-incentive'
  | 'merkl-claim'
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
  requiresPosition?: boolean;
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

export const MERKL_ABI = [
  'function claim(bytes32[] calldata proof, bytes32[] calldata proofFlags, bytes calldata data) external',
  'function getReward(address) external',
  'function claimable(address, address) view returns (uint256)',
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
// FALLBACK PROTOCOLS (Always Available)
// ============================================

const FALLBACK_PROTOCOLS: ProtocolConfig[] = [
  {
    id: 'quickswap-gamma-weth-usdc',
    name: 'QuickSwap Gamma WETH/USDC',
    priority: 1,
    address: '0x5b8C73C8488fAc99CD3Ff7BdC52ECdF062bC7143',
    functions: [
      { name: 'getReward', signature: 'getReward()' },
      { name: 'harvest', signature: 'harvest()' },
    ],
    rewardToken: TOKENS.WETH,
    entryToken: TOKENS.USDC,
    rewardType: 'harvest-triggered',
    skipForCallerHarvest: false,
    abi: GAMMA_ABI,
    requiresPosition: false,
  },
  {
    id: 'quickswap-gamma-wbtc-usdc',
    name: 'QuickSwap Gamma WBTC/USDC',
    priority: 1,
    address: '0x0dF1bE0aE59E87C5e66c583EE4F88373c8bbAcE9',
    functions: [
      { name: 'getReward', signature: 'getReward()' },
      { name: 'harvest', signature: 'harvest()' },
    ],
    rewardToken: TOKENS.WBTC,
    entryToken: TOKENS.USDC,
    rewardType: 'harvest-triggered',
    skipForCallerHarvest: false,
    abi: GAMMA_ABI,
    requiresPosition: false,
  },
  {
    id: 'quickswap-gamma-wmatic-usdc',
    name: 'QuickSwap Gamma WMATIC/USDC',
    priority: 1,
    address: '0x7Dd11D9D578b0B8756A4F2c6A8E96D5c0B33E274',
    functions: [
      { name: 'getReward', signature: 'getReward()' },
      { name: 'harvest', signature: 'harvest()' },
    ],
    rewardToken: TOKENS.WMATIC,
    entryToken: TOKENS.USDC,
    rewardType: 'harvest-triggered',
    skipForCallerHarvest: false,
    abi: GAMMA_ABI,
    requiresPosition: false,
  },
];

// ============================================
// ADAPTER 2: MERKL-CLAIM (Gamma / QuickSwap ALM)
// ============================================

let merklProtocols: ProtocolConfig[] = [];

export function setMerklProtocols(pools: { 
  id: string; 
  token0: { id: string; symbol: string; decimals: string }; 
  token1: { id: string; symbol: string; decimals: string };
  totalValueLockedUSD?: string;
}[]): void {
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
    skipForCallerHarvest: true,
    abi: MERKL_ABI,
    requiresPosition: true,
    tvlUsd: pool.totalValueLockedUSD || '0',
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
  ...FALLBACK_PROTOCOLS,
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

// ✅ Check if a protocol is harvestable
export function isHarvestable(protocol: ProtocolConfig): boolean {
  return !protocol.skipForCallerHarvest && 
    (protocol.rewardType === 'harvest-triggered' || protocol.rewardType === 'keeper-incentive');
}

// ============================================
// PROTOCOL FACTORIES
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
    requiresPosition: false,
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
    requiresPosition: false,
  };
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

// ✅ Export setDiscoveredProtocols for backward compatibility
export function setDiscoveredProtocols(protocols: ProtocolConfig[]): void {
  // This is a no-op now since we use setMerklProtocols for discovery
  // Kept for backward compatibility
  log.info(`setDiscoveredProtocols called with ${protocols.length} protocols (no-op)`);
}