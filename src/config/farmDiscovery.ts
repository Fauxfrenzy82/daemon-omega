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
 * Verified: https://polygonscan.com/address/0x917d33f5420dd10c6507e6e56cfc0cf63babe58e
 */
const QUICKSWAP_V3_FACTORY = '0x917d33f5420dd10c6507e6e56cfc0cf63babe58e';

/**
 * Gamma Hypervisor Factory / Registry
 * Used to find active Gamma farms
 */
const GAMMA_HYPERVISOR_FACTORY = '0x6f8a9D0C8C46Fb15F72eA3B1d709a516a3BeE620';

/**
 * ABI for QuickSwap V3 Factory – used to get pool addresses
 */
const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
  'function allPools(uint256 index) external view returns (address)',
  'function allPoolsLength() external view returns (uint256)',
];

/**
 * ABI for Gamma Hypervisor – used to check if a farm is active
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
 * ABI for QuickSwap V3 Farm (MasterChef style)
 */
const FARM_ABI = [
  'function lpToken() external view returns (address)',
  'function rewardToken() external view returns (address)',
  'function userInfo(uint256 pid, address user) external view returns (uint256 amount, uint256 rewardDebt)',
  'function pendingReward(uint256 pid, address user) external view returns (uint256)',
];

/**
 * Fee tiers for QuickSwap V3
 * Source: QuickSwap Documentation 
 */
const FEE_TIERS = [100, 500, 3000, 10000];

/**
 * Known token pairs to discover farms for
 * Maps pair ID to token addresses
 */
const TARGET_PAIRS: Record<string, { tokenA: TokenInfo; tokenB: TokenInfo; fee: number }> = {
  'WETH-USDC': { tokenA: TOKENS.WETH, tokenB: TOKENS.USDC, fee: 3000 },
  'WBTC-USDC': { tokenA: TOKENS.WBTC, tokenB: TOKENS.USDC, fee: 3000 },
  'WMATIC-USDC': { tokenA: TOKENS.WMATIC, tokenB: TOKENS.USDC, fee: 3000 },
  'AAVE-USDC': { tokenA: TOKENS.AAVE, tokenB: TOKENS.USDC, fee: 3000 },
  'USDC-USDT': { tokenA: TOKENS.USDC, tokenB: TOKENS.USDT, fee: 500 },
};

/**
 * Fetch a pool address from the QuickSwap V3 Factory
 */
async function getPoolAddress(
  factory: ethers.Contract,
  tokenA: string,
  tokenB: string,
  fee: number
): Promise<string | null> {
  try {
    const pool = await factory.getPool(tokenA, tokenB, fee);
    if (pool && pool !== ethers.constants.AddressZero) {
      return pool;
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Check if a pool has an active Gamma farm
 * A Gamma farm is active if it has a Hypervisor with totalSupply > 0
 */
async function findGammaFarmForPool(
  poolAddress: string
): Promise<{ hypervisorAddress: string | null; farmAddress: string | null }> {
  try {
    const hypervisor = new ethers.Contract(poolAddress, HYPERVISOR_ABI, provider);
    
    try {
      const totalSupply = await hypervisor.totalSupply();
      if (totalSupply && totalSupply.gt(0)) {
        log.debug(`Found active Gamma Hypervisor at ${poolAddress}`, {
          totalSupply: ethers.utils.formatEther(totalSupply),
        });
        return {
          hypervisorAddress: poolAddress,
          farmAddress: null,
        };
      }
    } catch (err) {
      // Not a Hypervisor
    }
    
    return { hypervisorAddress: null, farmAddress: null };
  } catch (err) {
    return { hypervisorAddress: null, farmAddress: null };
  }
}

/**
 * Discover active QuickSwap V3 Gamma farms for target pairs
 */
export async function discoverGammaFarms(): Promise<Record<string, string>> {
  const farms: Record<string, string> = {};
  
  // ✅ Check if API key is set
  const subgraphApiKey = env.SUBGRAPH_API_KEY;
  if (!subgraphApiKey) {
    log.warn('❌ SUBGRAPH_API_KEY is not set!');
    return farms;
  }
  
  const subgraphId = '5AK9Y4tk27ZWrPKvSAUQmffXWyQvjWqyJ2GNEZUWTirU';
  const endpoint = `https://gateway.thegraph.com/api/${subgraphApiKey}/subgraphs/id/${subgraphId}`;
  
  log.info('🔍 Discovering QuickSwap V3 Gamma farms...', { 
    endpoint: endpoint.replace(subgraphApiKey, '***') 
  });

  const currentTimestamp = Math.floor(Date.now() / 1000);
  
  // ✅ Query the subgraph for active incentives
  const query = `
    {
      incentives(
        where: { endTime_gt: "${currentTimestamp}" }
        first: 20
        orderBy: endTime
        orderDirection: asc
      ) {
        id
        rewardToken
        bonusRewardToken
        totalReward
        bonusReward
        startTime
        endTime
        pool {
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
        }
      }
    }
  `;

  try {
    log.info('📡 Querying QuickSwap subgraph for incentives...');
    const response = await axios.post(endpoint, { query }, { timeout: 15000 });
    
    if (response.data?.errors) {
      log.error('❌ Subgraph errors:', {
        errors: JSON.stringify(response.data.errors, null, 2),
      });
      return farms;
    }
    
    const incentives = response.data?.data?.incentives || [];
    log.info(`📊 Found ${incentives.length} active incentives in subgraph response`);
    
    if (incentives.length === 0) {
      log.warn('⚠️ No incentives found in subgraph response');
      return farms;
    }

    for (const inc of incentives) {
      if (!inc.pool?.id) continue;
      
      const pairId = `${inc.pool.token0?.symbol}/${inc.pool.token1?.symbol}`;
      farms[pairId] = inc.pool.id;
      log.debug(`Added Gamma farm: ${pairId} -> ${inc.pool.id}`);
    }

  } catch (err: any) {
    log.error('❌ Incentive query failed:', {
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
 * Generate RewardPositions from discovered farms
 * Combines hardcoded farms (like Aave) with discovered ones
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
  });
  
  // 2. Discover and add Gamma farms
  const gammaFarms = await discoverGammaFarms();
  
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
    
    log.info(`📦 Added discovered farm: ${id}`, {
      address,
      rewardToken: rewardToken.symbol,
    });
  }
  
  // 3. Add Beefy and Balancer farms if addresses are provided via env
  const beefyAddress = env.BEEFY_VAULT_ADDRESS;
  if (beefyAddress && ethers.utils.isAddress(beefyAddress)) {
    positions.push({
      id: 'beefy-wbtc-wmatic',
      positionAddress: beefyAddress,
      rewardToken: TOKENS.WBTC,
      entryToken: TOKENS.USDC,
      protocol: 'beefy',
    });
    log.info(`📦 Added Beefy vault from env: ${beefyAddress}`);
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
    log.info(`📦 Added Balancer gauge from env: ${balancerGauge}`);
  }
  
  log.info(`📊 Total farms configured: ${positions.length}`);
  return positions;
}