// src/config/protocolDiscovery.ts

import axios from 'axios';
import { ethers } from 'ethers';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';
import { provider } from '../treasury/wallets';
import { TOKENS, TokenInfo } from './tokens';
import { env } from './env';

const log = createLogger('protocolDiscovery');

// ============================================
// TYPES
// ============================================

export interface DiscoveredProtocol {
  id: string;
  name: string;
  address: string;
  rewardToken: TokenInfo;
  entryToken: TokenInfo;
  protocol: string;
  priority: 1 | 2 | 3;
  functionNames: string[];
}

export interface BeefyVault {
  id: string;
  name: string;
  token: string;
  earnedTokenAddress: string;
  earnedToken: string;
  platformId: string;
}

// ============================================
// BEEFY FINANCE DISCOVERY
// ============================================

/**
 * Fetch all Beefy vaults from their public API
 * Endpoint: https://api.beefy.finance/config/polygon
 * Returns: Array of vault configurations
 */
export async function discoverBeefyVaults(): Promise<DiscoveredProtocol[]> {
  const protocols: DiscoveredProtocol[] = [];

  try {
    log.info('🔍 Discovering Beefy vaults from API...');
    
    const response = await withRetry(
      () => axios.get<Record<string, BeefyVault>>('https://api.beefy.finance/config/polygon', {
        timeout: 10000,
      }),
      { label: 'beefy.discovery', shouldRetry: isTransientError, retries: 2 }
    );

    const vaults = response.data;

    // Filter for relevant vaults on Polygon
    const relevantVaults = Object.entries(vaults).filter(([_, vault]) => {
      // Only include vaults with positive TVL and valid addresses
      return vault.earnedTokenAddress && 
             ethers.utils.isAddress(vault.earnedTokenAddress) &&
             vault.earnedTokenAddress !== '0x0000000000000000000000000000000000000000';
    });

    log.info(`Found ${relevantVaults.length} Beefy vaults`);

    // Take top 10 by TVL (or priority)
    for (const [id, vault] of relevantVaults.slice(0, 10)) {
      // Map token symbol to our TokenInfo
      const tokenSymbol = vault.token || 'USDC';
      let rewardToken = TOKENS.USDC;
      let entryToken = TOKENS.USDC;

      // Try to map to known tokens
      const symbolUpper = tokenSymbol.toUpperCase();
      if (symbolUpper.includes('WETH') || symbolUpper.includes('ETH')) {
        rewardToken = TOKENS.WETH;
      } else if (symbolUpper.includes('WBTC') || symbolUpper.includes('BTC')) {
        rewardToken = TOKENS.WBTC;
      } else if (symbolUpper.includes('MATIC') || symbolUpper.includes('POL')) {
        rewardToken = TOKENS.WMATIC;
      } else if (symbolUpper.includes('AAVE')) {
        rewardToken = TOKENS.AAVE;
      }

      protocols.push({
        id: `beefy-${id}`,
        name: vault.name || `Beefy ${id}`,
        address: vault.earnedTokenAddress,
        rewardToken: rewardToken,
        entryToken: entryToken,
        protocol: 'beefy',
        priority: 1,
        functionNames: ['harvest', 'getReward', 'earn'],
      });

      log.debug(`Added Beefy vault: ${vault.name} -> ${vault.earnedTokenAddress}`);
    }

  } catch (err) {
    log.warn('Failed to discover Beefy vaults from API', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return protocols;
}

// ============================================
// QUICKSWAP GAMMA DISCOVERY (via Subgraph)
// ============================================

/**
 * Discover QuickSwap Gamma farms from subgraph
 * These are permissionless harvest opportunities
 */
export async function discoverGammaFarms(): Promise<DiscoveredProtocol[]> {
  const protocols: DiscoveredProtocol[] = [];

  const subgraphApiKey = env.SUBGRAPH_API_KEY;
  if (!subgraphApiKey) {
    log.warn('SUBGRAPH_API_KEY not set, skipping Gamma farm discovery');
    return protocols;
  }

  const subgraphId = '5AK9Y4tk27ZWrPKvSAUQmffXWyQvjWqyJ2GNEZUWTirU';
  const endpoint = `https://gateway.thegraph.com/api/${subgraphApiKey}/subgraphs/id/${subgraphId}`;

  try {
    log.info('🔍 Discovering QuickSwap Gamma farms from subgraph...');

    const query = `
      {
        incentives(
          where: { endTime_gt: "${Math.floor(Date.now() / 1000)}" }
          first: 20
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

    const response = await withRetry(
      () => axios.post(endpoint, { query }, { timeout: 15000 }),
      { label: 'gamma.discovery', shouldRetry: isTransientError, retries: 2 }
    );

    const incentives = response.data?.data?.incentives || [];

    log.info(`Found ${incentives.length} active Gamma incentives`);

    for (const inc of incentives) {
      if (!inc.pool?.id) continue;

      const rewardTokenAddress = inc.rewardToken?.toLowerCase() || '';
      let rewardToken = TOKENS.QUICK;
      let entryToken = TOKENS.USDC;

      // Map reward token
      if (rewardTokenAddress === TOKENS.WETH.address.toLowerCase()) {
        rewardToken = TOKENS.WETH;
      } else if (rewardTokenAddress === TOKENS.WBTC.address.toLowerCase()) {
        rewardToken = TOKENS.WBTC;
      } else if (rewardTokenAddress === TOKENS.WMATIC.address.toLowerCase()) {
        rewardToken = TOKENS.WMATIC;
      } else if (rewardTokenAddress === TOKENS.USDC.address.toLowerCase() ||
                 rewardTokenAddress === TOKENS.USDCe.address.toLowerCase()) {
        rewardToken = TOKENS.USDC;
      } else if (rewardTokenAddress === TOKENS.USDT.address.toLowerCase()) {
        rewardToken = TOKENS.USDT;
      } else if (rewardTokenAddress === TOKENS.AAVE.address.toLowerCase()) {
        rewardToken = TOKENS.AAVE;
      }

      // Entry token is typically the pool token0
      if (inc.pool?.token0?.id) {
        const token0Addr = inc.pool.token0.id.toLowerCase();
        for (const [symbol, token] of Object.entries(TOKENS)) {
          if (token.address.toLowerCase() === token0Addr) {
            entryToken = token;
            break;
          }
        }
      }

      protocols.push({
        id: `quickswap-gamma-${inc.pool.id}`,
        name: `QuickSwap Gamma ${inc.pool.token0?.symbol}/${inc.pool.token1?.symbol}`,
        address: inc.pool.id,
        rewardToken: rewardToken,
        entryToken: entryToken,
        protocol: 'quickswap-gamma',
        priority: 1,
        functionNames: ['getReward', 'harvest', 'compound'],
      });

      log.debug(`Added Gamma farm: ${inc.pool.token0?.symbol}/${inc.pool.token1?.symbol}`);
    }

  } catch (err) {
    log.warn('Failed to discover Gamma farms from subgraph', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return protocols;
}

// ============================================
// QUICKSWAP FARMS DISCOVERY
// ============================================

/**
 * Discover QuickSwap farms (MasterChef style)
 * These are permissionless reward harvesting opportunities
 */
export async function discoverQuickSwapFarms(): Promise<DiscoveredProtocol[]> {
  const protocols: DiscoveredProtocol[] = [];

  const subgraphApiKey = env.SUBGRAPH_API_KEY;
  if (!subgraphApiKey) {
    return protocols;
  }

  const subgraphId = '5AK9Y4tk27ZWrPKvSAUQmffXWyQvjWqyJ2GNEZUWTirU';
  const endpoint = `https://gateway.thegraph.com/api/${subgraphApiKey}/subgraphs/id/${subgraphId}`;

  try {
    log.info('🔍 Discovering QuickSwap farms from subgraph...');

    const query = `
      {
        farms(
          first: 10
        ) {
          id
          pair
          rewardToken
          rewardPerBlock
          totalAllocPoint
          poolInfo {
            lpToken
            allocPoint
            lastRewardBlock
            accRewardPerShare
          }
        }
      }
    `;

    const response = await withRetry(
      () => axios.post(endpoint, { query }, { timeout: 15000 }),
      { label: 'farm.discovery', shouldRetry: isTransientError, retries: 2 }
    );

    const farms = response.data?.data?.farms || [];

    log.info(`Found ${farms.length} QuickSwap farms`);

    for (const farm of farms.slice(0, 5)) {
      if (!farm.poolInfo?.[0]?.lpToken) continue;

      const lpToken = farm.poolInfo[0].lpToken;
      const rewardTokenAddress = farm.rewardToken?.toLowerCase() || '';

      let rewardToken = TOKENS.QUICK;
      let entryToken = TOKENS.USDC;

      if (rewardTokenAddress === TOKENS.QUICK.address.toLowerCase()) {
        rewardToken = TOKENS.QUICK;
      }

      protocols.push({
        id: `quickswap-farm-${farm.id}`,
        name: `QuickSwap Farm ${farm.id}`,
        address: lpToken,
        rewardToken: rewardToken,
        entryToken: entryToken,
        protocol: 'quickswap-farm',
        priority: 1,
        functionNames: ['getReward', 'harvest'],
      });

      log.debug(`Added QuickSwap farm: ${farm.id}`);
    }

  } catch (err) {
    log.warn('Failed to discover QuickSwap farms from subgraph', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return protocols;
}

// ============================================
// CONVEX DISCOVERY (via on-chain or API)
// ============================================

/**
 * Discover Convex reward pools
 * These often have keeper incentives for calling getReward()
 */
export async function discoverConvexPools(): Promise<DiscoveredProtocol[]> {
  const protocols: DiscoveredProtocol[] = [];

  // Convex uses a registry pattern
  // The main registry on Polygon is:
  const CONVEX_REGISTRY = '0x...'; // Would need to verify

  try {
    log.info('🔍 Discovering Convex pools...');

    // For now, use env override or skip
    const convexAddress = env.CONVEX_ADDRESS;
    if (convexAddress && ethers.utils.isAddress(convexAddress)) {
      protocols.push({
        id: 'convex-rewards',
        name: 'Convex Rewards',
        address: convexAddress,
        rewardToken: TOKENS.USDC,
        entryToken: TOKENS.USDC,
        protocol: 'convex',
        priority: 2,
        functionNames: ['getReward', 'claim'],
      });
      log.info(`Added Convex pool: ${convexAddress}`);
    }

  } catch (err) {
    log.warn('Failed to discover Convex pools', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return protocols;
}

// ============================================
// HARVEST FINANCE DISCOVERY
// ============================================

/**
 * Discover Harvest Finance vaults
 * These have caller incentives for harvest()
 */
export async function discoverHarvestVaults(): Promise<DiscoveredProtocol[]> {
  const protocols: DiscoveredProtocol[] = [];

  try {
    log.info('🔍 Discovering Harvest Finance vaults...');

    // Harvest Finance uses a factory pattern on Polygon
    // Addresses can be found via their public API or GitHub

    const harvestAddress = env.HARVEST_VAULT_ADDRESS;
    if (harvestAddress && ethers.utils.isAddress(harvestAddress)) {
      protocols.push({
        id: 'harvest-finance',
        name: 'Harvest Finance Vault',
        address: harvestAddress,
        rewardToken: TOKENS.USDC,
        entryToken: TOKENS.USDC,
        protocol: 'harvest',
        priority: 2,
        functionNames: ['harvest', 'getReward'],
      });
      log.info(`Added Harvest vault: ${harvestAddress}`);
    }

  } catch (err) {
    log.warn('Failed to discover Harvest vaults', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return protocols;
}

// ============================================
// MAIN DISCOVERY FUNCTION
// ============================================

/**
 * Run all discovery services once at startup
 * Returns a combined list of all discovered protocols
 */
export async function discoverAllProtocols(): Promise<DiscoveredProtocol[]> {
  log.info('🚀 Running complete protocol discovery...');

  const allProtocols: DiscoveredProtocol[] = [];

  // 1. Discover Beefy vaults
  const beefy = await discoverBeefyVaults();
  allProtocols.push(...beefy);

  // 2. Discover Gamma farms
  const gamma = await discoverGammaFarms();
  allProtocols.push(...gamma);

  // 3. Discover QuickSwap farms
  const farms = await discoverQuickSwapFarms();
  allProtocols.push(...farms);

  // 4. Discover Convex pools
  const convex = await discoverConvexPools();
  allProtocols.push(...convex);

  // 5. Discover Harvest vaults
  const harvest = await discoverHarvestVaults();
  allProtocols.push(...harvest);

  // Add manual overrides from env (if set)
  const manualAddresses = [
    { key: env.BEEFY_VAULT_ADDRESS, id: 'beefy-manual', name: 'Beefy Manual', token: TOKENS.USDC },
    { key: env.BEEFY_WETH_VAULT, id: 'beefy-weth-manual', name: 'Beefy WETH Manual', token: TOKENS.WETH },
  ];

  for (const manual of manualAddresses) {
    if (manual.key && ethers.utils.isAddress(manual.key)) {
      // Check if already discovered
      const exists = allProtocols.some(p => p.address.toLowerCase() === manual.key.toLowerCase());
      if (!exists) {
        allProtocols.push({
          id: manual.id,
          name: manual.name,
          address: manual.key,
          rewardToken: manual.token,
          entryToken: TOKENS.USDC,
          protocol: 'beefy',
          priority: 1,
          functionNames: ['harvest', 'getReward'],
        });
        log.info(`Added manual override: ${manual.name} -> ${manual.key}`);
      }
    }
  }

  log.info(`✅ Discovery complete: ${allProtocols.length} protocols found`);

  // Log summary by protocol type
  const summary = allProtocols.reduce((acc, p) => {
    acc[p.protocol] = (acc[p.protocol] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  log.info('📊 Discovery summary', { summary });

  return allProtocols;
}