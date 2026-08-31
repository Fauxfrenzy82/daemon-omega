// src/config/farmDiscovery.ts

import axios from 'axios';
import { ethers } from 'ethers';
import { TokenInfo } from './tokens';
import { TOKENS } from './tokens';
import { provider } from '../treasury/wallets';
import { createLogger } from '../utils/logger';
import { env } from './env';

const log = createLogger('farmDiscovery');

/**
 * QuickSwap V3 Factory Address on Polygon
 */
const QUICKSWAP_V3_FACTORY = '0x917d33f5420dd10c6507e6e56cfc0cf63babe58e';

/**
 * ABI for QuickSwap V3 Factory
 */
const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
  'function allPools(uint256 index) external view returns (address)',
  'function allPoolsLength() external view returns (uint256)',
];

/**
 * Pool type returned from subgraph
 */
export interface SubgraphPool {
  id: string;
  token0: { id: string; symbol: string; decimals: string };
  token1: { id: string; symbol: string; decimals: string };
  liquidity: string;
  token0Price: string;
  token1Price: string;
  totalValueLockedUSD: string;
}

/**
 * Simplified pool type for on-chain discovery
 */
export interface SimplePool {
  id: string;
  token0: { id: string; symbol: string; decimals: string };
  token1: { id: string; symbol: string; decimals: string };
  totalValueLockedUSD?: string;
}

/**
 * ✅ FIXED: Query only fields that exist in the QuickSwap V3 subgraph schema
 */
export async function discoverGammaPools(): Promise<SubgraphPool[]> {
  const subgraphApiKey = env.SUBGRAPH_API_KEY;
  if (!subgraphApiKey) {
    log.warn('❌ SUBGRAPH_API_KEY is not set!');
    return [];
  }

  const subgraphId = '5AK9Y4tk27ZWrPKvSAUQmffXWyQvjWqyJ2GNEZUWTirU';
  const endpoint = `https://gateway.thegraph.com/api/${subgraphApiKey}/subgraphs/id/${subgraphId}`;

  log.info('🔍 Discovering QuickSwap V3 pools...');

  const query = `
    {
      pools(
        first: 1000
        orderBy: totalValueLockedUSD
        orderDirection: desc
      ) {
        id
        token0 {
          id
          symbol
          decimals
        }
        token1 {
          id
          symbol
          decimals
        }
        liquidity
        token0Price
        token1Price
        totalValueLockedUSD
      }
    }
  `;

  try {
    const response = await axios.post(endpoint, { query }, { timeout: 15000 });

    if (response.data?.errors) {
      log.error('❌ Subgraph errors:', {
        errors: JSON.stringify(response.data.errors, null, 2),
      });
      return [];
    }

    const pools = response.data?.data?.pools || [];
    log.info(`📊 Found ${pools.length} pools with TVL > 0`);
    return pools;
  } catch (err: any) {
    log.error('❌ Subgraph query failed:', {
      status: err?.response?.status,
      message: err?.message,
    });
    return [];
  }
}

/**
 * Discover pools on-chain as fallback
 */
export async function discoverPoolsOnChain(): Promise<SimplePool[]> {
  const pools: SimplePool[] = [];

  try {
    log.info('🔍 Discovering pools on-chain...');
    const factory = new ethers.Contract(QUICKSWAP_V3_FACTORY, FACTORY_ABI, provider);

    let poolCount = 0;
    try {
      const count = await factory.allPoolsLength();
      poolCount = Number(count);
    } catch {
      return pools;
    }

    const maxPools = Math.min(poolCount, 50);

    for (let i = 0; i < maxPools; i++) {
      try {
        const poolAddress = await factory.allPools(i);
        if (!poolAddress || poolAddress === ethers.constants.AddressZero) continue;

        const pool = new ethers.Contract(poolAddress, [
          'function token0() view returns (address)',
          'function token1() view returns (address)',
        ], provider);

        const token0 = await pool.token0();
        const token1 = await pool.token1();

        pools.push({
          id: poolAddress,
          token0: { id: token0, symbol: 'Unknown', decimals: '18' },
          token1: { id: token1, symbol: 'Unknown', decimals: '18' },
          totalValueLockedUSD: '0',
        });
      } catch {
        continue;
      }
    }

    log.info(`🔍 Discovered ${pools.length} pools on-chain`);
  } catch (err) {
    log.warn('On-chain discovery failed:', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return pools;
}

/**
 * ✅ EXPORTED: Discover Gamma farms (alias for discoverGammaPools)
 * Kept for backward compatibility with imports
 */
export async function discoverGammaFarms(): Promise<Record<string, string>> {
  const pools = await discoverGammaPools();
  const farms: Record<string, string> = {};
  
  for (const pool of pools) {
    const pairId = `${pool.token0.symbol}/${pool.token1.symbol}`;
    farms[pairId] = pool.id;
  }
  
  return farms;
}

/**
 * Generate reward positions from discovered pools
 */
export async function generateRewardPositions(): Promise<any[]> {
  const positions: any[] = [];

  // 1. Add hardcoded farms (Aave RewardsController)
  positions.push({
    id: 'aave-rewards',
    positionAddress: '0x5f4d15d761528c57a5c30c43c1dab26fc5452731',
    rewardToken: TOKENS.AAVE,
    entryToken: TOKENS.USDC,
    protocol: 'aave',
    rewardType: 'harvest-triggered',
  });

  // 2. Discover pools from subgraph
  const pools = await discoverGammaPools();

  if (pools.length === 0) {
    log.info('No pools from subgraph, trying on-chain...');
    const onChainPools = await discoverPoolsOnChain();
    for (const pool of onChainPools) {
      const pairId = `${pool.token0.symbol}/${pool.token1.symbol}`;
      positions.push({
        id: `quickswap-pool-${pairId.toLowerCase()}`,
        positionAddress: pool.id,
        rewardToken: TOKENS.QUICK,
        entryToken: TOKENS.USDC,
        protocol: 'quickswap-pool',
        rewardType: 'merkl-claim',
        requiresPosition: true,
      });
    }
  } else {
    for (const pool of pools) {
      const pairId = `${pool.token0.symbol}/${pool.token1.symbol}`;
      positions.push({
        id: `quickswap-pool-${pairId.toLowerCase()}`,
        positionAddress: pool.id,
        rewardToken: TOKENS.QUICK,
        entryToken: TOKENS.USDC,
        protocol: 'quickswap-pool',
        rewardType: 'merkl-claim',
        requiresPosition: true,
        tvlUsd: pool.totalValueLockedUSD,
      });
    }
  }

  // 3. Add Beefy vaults from env (harvest-triggered)
  const beefyAddress = env.BEEFY_VAULT_ADDRESS;
  if (beefyAddress && ethers.utils.isAddress(beefyAddress)) {
    positions.push({
      id: 'beefy-wbtc-wmatic',
      positionAddress: beefyAddress,
      rewardToken: TOKENS.WBTC,
      entryToken: TOKENS.USDC,
      protocol: 'beefy',
      rewardType: 'harvest-triggered',
      requiresPosition: false,
    });
  }

  const beefyWethAddress = env.BEEFY_WETH_VAULT;
  if (beefyWethAddress && ethers.utils.isAddress(beefyWethAddress)) {
    positions.push({
      id: 'beefy-weth-usdc',
      positionAddress: beefyWethAddress,
      rewardToken: TOKENS.WETH,
      entryToken: TOKENS.USDC,
      protocol: 'beefy',
      rewardType: 'harvest-triggered',
      requiresPosition: false,
    });
  }

  log.info(`📊 Total positions configured: ${positions.length}`);
  return positions;
}