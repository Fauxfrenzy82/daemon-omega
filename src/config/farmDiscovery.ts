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
 * ABI for Gamma Hypervisor
 */
const HYPERVISOR_ABI = [
  'function pool() external view returns (address)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function totalSupply() external view returns (uint256)',
  'function getReward() external',
  'function earned(address account) external view returns (uint256)',
];

/**
 * Known token pairs to discover farms for
 */
const TARGET_PAIRS: Record<string, { tokenA: TokenInfo; tokenB: TokenInfo; fee: number }> = {
  'WETH-USDC': { tokenA: TOKENS.WETH, tokenB: TOKENS.USDC, fee: 3000 },
  'WBTC-USDC': { tokenA: TOKENS.WBTC, tokenB: TOKENS.USDC, fee: 3000 },
  'WMATIC-USDC': { tokenA: TOKENS.WMATIC, tokenB: TOKENS.USDC, fee: 3000 },
  'AAVE-USDC': { tokenA: TOKENS.AAVE, tokenB: TOKENS.USDC, fee: 3000 },
  'USDC-USDT': { tokenA: TOKENS.USDC, tokenB: TOKENS.USDT, fee: 500 },
};

/**
 * ✅ CORRECTED: Discover Gamma farms using the correct subgraph schema
 * The QuickSwap V3 subgraph has pools with rewards, not a top-level "incentives" field
 */
export async function discoverGammaFarms(): Promise<Record<string, string>> {
  const farms: Record<string, string> = {};
  
  const subgraphApiKey = env.SUBGRAPH_API_KEY;
  if (!subgraphApiKey) {
    log.warn('❌ SUBGRAPH_API_KEY is not set!');
    return farms;
  }
  
  const subgraphId = '5AK9Y4tk27ZWrPKvSAUQmffXWyQvjWqyJ2GNEZUWTirU';
  const endpoint = `https://gateway.thegraph.com/api/${subgraphApiKey}/subgraphs/id/${subgraphId}`;
  
  log.info('🔍 Discovering QuickSwap V3 Gamma farms...');

  // ✅ CORRECTED QUERY: Query pools with rewards directly
  const query = `
    {
      pools(
        where: { totalValueLockedUSD_gt: "1000" }
        first: 20
        orderBy: totalValueLockedUSD
        orderDirection: desc
      ) {
        id
        feeTier
        totalValueLockedUSD
        token0 {
          id
          symbol
          decimals
          name
        }
        token1 {
          id
          symbol
          decimals
          name
        }
        rewards {
          id
          token {
            id
            symbol
            decimals
          }
          amount
          startTimestamp
          endTimestamp
        }
      }
    }
  `;

  try {
    log.info('📡 Querying QuickSwap subgraph for pools with rewards...');
    const response = await axios.post(endpoint, { query }, { timeout: 15000 });
    
    if (response.data?.errors) {
      log.error('❌ Subgraph errors:', {
        errors: JSON.stringify(response.data.errors, null, 2),
      });
      
      // ✅ Try alternative query if the first one fails
      log.info('🔄 Trying alternative query...');
      const altQuery = `
        {
          pools(
            first: 20
            orderBy: totalValueLockedUSD
            orderDirection: desc
          ) {
            id
            token0 { id symbol decimals }
            token1 { id symbol decimals }
            feeTier
            totalValueLockedUSD
          }
        }
      `;
      
      const altResponse = await axios.post(endpoint, { query: altQuery }, { timeout: 15000 });
      
      if (altResponse.data?.errors) {
        log.error('❌ Alternative query also failed:', {
          errors: JSON.stringify(altResponse.data.errors, null, 2),
        });
        return farms;
      }
      
      const pools = altResponse.data?.data?.pools || [];
      log.info(`📊 Found ${pools.length} pools via alternative query`);
      
      for (const pool of pools) {
        if (!pool.id) continue;
        const pairId = `${pool.token0?.symbol}/${pool.token1?.symbol}`;
        farms[pairId] = pool.id;
        log.debug(`Added pool: ${pairId} -> ${pool.id} (TVL: $${pool.totalValueLockedUSD})`);
      }
      
      return farms;
    }
    
    const pools = response.data?.data?.pools || [];
    log.info(`📊 Found ${pools.length} pools with rewards`);
    
    if (pools.length === 0) {
      log.warn('⚠️ No pools found in subgraph response');
      return farms;
    }

    for (const pool of pools) {
      if (!pool.id) continue;
      
      const pairId = `${pool.token0?.symbol}/${pool.token1?.symbol}`;
      farms[pairId] = pool.id;
      log.debug(`Added Gamma farm: ${pairId} -> ${pool.id} (TVL: $${pool.totalValueLockedUSD})`);
    }

  } catch (err: any) {
    log.error('❌ Subgraph query failed:', {
      status: err?.response?.status,
      statusText: err?.response?.statusText,
      data: err?.response?.data ? JSON.stringify(err.response.data) : null,
      message: err?.message,
    });
  }

  log.info(`🔍 Discovered ${Object.keys(farms).length} Gamma farms`);
  return farms;
}

/**
 * Discover QuickSwap farms via on-chain factory
 * Fallback method that doesn't rely on subgraph
 */
export async function discoverGammaFarmsOnChain(): Promise<Record<string, string>> {
  const farms: Record<string, string> = {};
  
  try {
    log.info('🔍 Discovering Gamma farms via on-chain factory...');
    const factory = new ethers.Contract(QUICKSWAP_V3_FACTORY, FACTORY_ABI, provider);
    
    // Try to get all pools
    let poolCount = 0;
    try {
      const count = await factory.allPoolsLength();
      poolCount = Number(count);
      log.info(`Found ${poolCount} pools in factory`);
    } catch (err) {
      log.warn('Could not get pool count from factory');
      return farms;
    }
    
    // Limit to first 20 pools to avoid rate limits
    const maxPools = Math.min(poolCount, 20);
    
    for (let i = 0; i < maxPools; i++) {
      try {
        const poolAddress = await factory.allPools(i);
        if (poolAddress && poolAddress !== ethers.constants.AddressZero) {
          // Try to get token info from the pool
          const pool = new ethers.Contract(poolAddress, [
            'function token0() view returns (address)',
            'function token1() view returns (address)',
          ], provider);
          
          const token0 = await pool.token0();
          const token1 = await pool.token1();
          
          // Map to known tokens
          let pairId = `pool-${i}`;
          for (const [id, config] of Object.entries(TARGET_PAIRS)) {
            if (token0.toLowerCase() === config.tokenA.address.toLowerCase() &&
                token1.toLowerCase() === config.tokenB.address.toLowerCase()) {
              pairId = id;
              break;
            }
          }
          
          farms[pairId] = poolAddress;
          log.debug(`Added on-chain pool: ${pairId} -> ${poolAddress}`);
        }
      } catch (err) {
        // Skip failed pools
      }
    }
  } catch (err) {
    log.warn('On-chain discovery failed:', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  
  return farms;
}

/**
 * Generate RewardPositions from discovered farms
 */
export async function generateRewardPositions(): Promise<any[]> {
  const positions: any[] = [];
  
  // 1. Add hardcoded farms
  positions.push({
    id: 'aave-rewards',
    positionAddress: '0x5f4d15d761528c57a5c30c43c1dab26fc5452731',
    rewardToken: TOKENS.AAVE,
    entryToken: TOKENS.USDC,
    protocol: 'aave',
  });
  
  // 2. Discover Gamma farms via subgraph
  const gammaFarms = await discoverGammaFarms();
  
  // 3. If subgraph fails, try on-chain discovery
  if (Object.keys(gammaFarms).length === 0) {
    log.info('Subgraph returned 0 farms, trying on-chain discovery...');
    const onChainFarms = await discoverGammaFarmsOnChain();
    for (const [pairId, address] of Object.entries(onChainFarms)) {
      const id = `quickswap-gamma-${pairId.toLowerCase()}`;
      const rewardToken = TARGET_PAIRS[pairId]?.tokenA || TOKENS.WMATIC;
      const entryToken = TARGET_PAIRS[pairId]?.tokenB || TOKENS.USDC;
      
      positions.push({
        id,
        positionAddress: address,
        rewardToken,
        entryToken,
        protocol: 'quickswap-gamma',
      });
    }
  } else {
    for (const [pairId, address] of Object.entries(gammaFarms)) {
      const id = `quickswap-gamma-${pairId.toLowerCase()}`;
      const rewardToken = TARGET_PAIRS[pairId]?.tokenA || TOKENS.WMATIC;
      const entryToken = TARGET_PAIRS[pairId]?.tokenB || TOKENS.USDC;
      
      positions.push({
        id,
        positionAddress: address,
        rewardToken,
        entryToken,
        protocol: 'quickswap-gamma',
      });
    }
  }
  
  // 4. Add Beefy and Balancer farms if addresses are provided
  const beefyAddress = env.BEEFY_VAULT_ADDRESS;
  if (beefyAddress && ethers.utils.isAddress(beefyAddress)) {
    positions.push({
      id: 'beefy-wbtc-wmatic',
      positionAddress: beefyAddress,
      rewardToken: TOKENS.WBTC,
      entryToken: TOKENS.USDC,
      protocol: 'beefy',
    });
  }
  
  const balancerGauge = env.BALANCER_GAUGE_ADDRESS;
  if (balancerGauge && ethers.utils.isAddress(balancerGauge)) {
    positions.push({
      id: 'balancer-wmatic-usdc',
      positionAddress: balancerGauge,
      rewardToken: TOKENS.WMATIC,
      entryToken: TOKENS.USDC,
      protocol: 'balancer',
    });
  }
  
  log.info(`📊 Total farms configured: ${positions.length}`);
  return positions;
}