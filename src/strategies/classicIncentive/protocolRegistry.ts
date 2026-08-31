// src/strategies/classicIncentive/protocolRegistry.ts

import { ethers } from 'ethers';
import { TokenInfo, TOKENS } from '../../config/tokens';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';

const log = createLogger('protocolRegistry');

// ============================================
// TYPES – distinguish opportunity types
// ============================================

export type OpportunityType = 
  | 'HARVEST_CALLER_REWARD'   // Beefy, Convex – caller gets paid
  | 'MERKL_CLAIM'             // Gamma/QuickSwap ALM – require position
  | 'LP_INCENTIVE'            // General LP rewards (position-based)
  | 'BORROW_INCENTIVE'        // Morpho-style (position-based)

export interface ProtocolConfig {
  id: string;
  name: string;
  priority: 1 | 2 | 3;
  address: string;
  functions: { name: string; signature: string; args?: string[] }[];
  rewardToken: TokenInfo;
  entryToken: TokenInfo;
  opportunityType: OpportunityType;  // ✅ NEW
  callerIncentiveBps?: number;
  requiresPosition: boolean;        // ✅ NEW
  skipForCallerHarvest: boolean;
  abi?: string[];
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

export const MERKL_ABI = [
  'function claim(bytes32[] calldata proof, bytes32[] calldata proofFlags, bytes calldata data) external',
  'function getReward(address) external',
  'function claimable(address, address) view returns (uint256)',
];

export const GAMMA_ABI = [
  'function getReward() external',
  'function harvest() external',
  'function earned(address) view returns (uint256)',
];

// ============================================
// HARDCODED HARVEST-TRIGGERED PROTOCOLS
// ============================================

const BEEFY_PROTOCOLS: ProtocolConfig[] = [
  {
    id: 'beefy-wbtc-wmatic',
    name: 'Beefy WBTC/WMATIC Vault',
    priority: 1,
    address: env.BEEFY_VAULT_ADDRESS || '',
    functions: [{ name: 'harvest', signature: 'harvest()' }],
    rewardToken: TOKENS.WBTC,
    entryToken: TOKENS.USDC,
    opportunityType: 'HARVEST_CALLER_REWARD',
    callerIncentiveBps: 200,
    requiresPosition: false,
    skipForCallerHarvest: false,
    abi: BEEFY_ABI,
  },
  {
    id: 'beefy-weth-usdc',
    name: 'Beefy WETH/USDC Vault',
    priority: 1,
    address: env.BEEFY_WETH_VAULT || '',
    functions: [{ name: 'harvest', signature: 'harvest()' }],
    rewardToken: TOKENS.WETH,
    entryToken: TOKENS.USDC,
    opportunityType: 'HARVEST_CALLER_REWARD',
    callerIncentiveBps: 200,
    requiresPosition: false,
    skipForCallerHarvest: false,
    abi: BEEFY_ABI,
  },
];

const CONVEX_PROTOCOLS: ProtocolConfig[] = [
  {
    id: 'convex-rewards',
    name: 'Convex Rewards',
    priority: 2,
    address: env.CONVEX_ADDRESS || '',
    functions: [{ name: 'getReward', signature: 'getReward()' }],
    rewardToken: TOKENS.USDC,
    entryToken: TOKENS.USDC,
    opportunityType: 'HARVEST_CALLER_REWARD',
    requiresPosition: false,
    skipForCallerHarvest: false,
    abi: CONVEX_ABI,
  },
];

// ============================================
// FALLBACK PROTOCOLS (always available)
// ============================================

const FALLBACK_PROTOCOLS: ProtocolConfig[] = [
  {
    id: 'quickswap-gamma-weth-usdc',
    name: 'QuickSwap Gamma WETH/USDC',
    priority: 1,
    address: '0x5b8C73C8488fAc99CD3Ff7BdC52ECdF062bC7143',
    functions: [{ name: 'getReward', signature: 'getReward()' }],
    rewardToken: TOKENS.WETH,
    entryToken: TOKENS.USDC,
    opportunityType: 'MERKL_CLAIM',
    requiresPosition: true,
    skipForCallerHarvest: true,
    abi: GAMMA_ABI,
  },
  // ... add similar for other fallback pools
];

// ============================================
// DYNAMIC MERKL POOLS (discovered from subgraph)
// ============================================

let merklPools: ProtocolConfig[] = [];

export function registerMerklPools(pools: {
  id: string;
  token0: { symbol: string };
  token1: { symbol: string };
  totalValueLockedUSD?: string;
}[]): void {
  merklPools = pools.map(pool => ({
    id: `merkl-${pool.id}`,
    name: `Merkl Pool ${pool.token0.symbol}/${pool.token1.symbol}`,
    priority: 1,
    address: pool.id,
    functions: [{ name: 'claim', signature: 'claim(bytes32[],bytes32[],bytes)' }],
    rewardToken: TOKENS.QUICK,
    entryToken: TOKENS.USDC,
    opportunityType: 'MERKL_CLAIM',
    requiresPosition: true,
    skipForCallerHarvest: true,
    abi: MERKL_ABI,
    tvlUsd: pool.totalValueLockedUSD || '0',
  }));
  log.info(`✅ Registered ${merklPools.length} Merkl pools (not yet checked for claimable rewards)`);
}

// ============================================
// EXPORT: Get protocols by opportunity type
// ============================================

export function getHarvestTriggeredProtocols(): ProtocolConfig[] {
  const all = [...BEEFY_PROTOCOLS, ...CONVEX_PROTOCOLS, ...FALLBACK_PROTOCOLS];
  return all.filter(p => 
    p.address && p.address !== '' && p.address !== ethers.constants.AddressZero &&
    p.opportunityType === 'HARVEST_CALLER_REWARD'
  );
}

export function getMerklPools(): ProtocolConfig[] {
  return merklPools.filter(p => p.address && p.address !== ethers.constants.AddressZero);
}

// ============================================
// HELPERS
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