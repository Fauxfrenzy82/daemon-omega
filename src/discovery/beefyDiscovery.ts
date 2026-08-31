// src/discovery/beefyDiscovery.ts

import axios from 'axios';
import { ethers } from 'ethers';
import { provider, executionWallet } from '../treasury/wallets';
import { createLogger } from '../utils/logger';
import { env } from '../config/env';
import { getEnsoRouteQuote } from '../scanner/sources/ensoRoute';
import { TOKENS, TokenInfo } from '../config/tokens';
import { OpportunityCandidate } from '../strategies/common/opportunityCandidate';
import { pushCandidate } from '../execution/queue';
import { withRetry, isTransientError } from '../utils/retry';

const log = createLogger('beefyDiscovery');

// ✅ CORRECT: Use the /vaults endpoint as documented
const BEEFY_API_URL = 'https://api.beefy.finance/vaults';

// Beefy vault ABI
const STRATEGY_ABI = [
  'function harvest() external',
  'function earned(address) view returns (uint256)',
  'function rewardToken() view returns (address)',
];

// Updated interface matching the actual API response
interface BeefyVault {
  id: string;
  name: string;
  token: string;
  tokenAddress: string;
  earnedToken: string;
  earnedTokenAddress: string;
  earnContractAddress: string;
  strategy: string;
  status: string; // 'active' or 'eol'
  chain: string; // 'polygon', 'ethereum', etc.
  network: string; // 'polygon', 'ethereum', etc.
  platformId: string;
  assets: string[];
  lastHarvest: number;
  pricePerFullShare: string;
}

/**
 * Fetch active Polygon Beefy vaults from the official API
 */
async function fetchBeefyVaults(): Promise<BeefyVault[]> {
  try {
    log.info(`📡 Fetching Beefy vaults from: ${BEEFY_API_URL}`);
    const response = await withRetry(
      () => axios.get(BEEFY_API_URL, { timeout: 10000 }),
      { label: 'beefy.api', shouldRetry: isTransientError, retries: 2 }
    );

    // The API returns an object with vault IDs as keys
    const data = response.data;
    
    // Log the structure to help debug
    log.debug('API response structure', {
      type: typeof data,
      isArray: Array.isArray(data),
      keys: typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).slice(0, 5) : null,
    });

    // Convert object to array if needed
    let vaultsArray: BeefyVault[] = [];
    if (Array.isArray(data)) {
      vaultsArray = data;
    } else if (data && typeof data === 'object') {
      vaultsArray = Object.values(data);
    } else {
      log.warn('Unexpected response format', { data });
      return [];
    }

    log.info(`📊 Raw vault count: ${vaultsArray.length}`);

    // Filter for Polygon + active
    const polygonVaults = vaultsArray.filter(v => 
      (v.chain === 'polygon' || v.network === 'polygon') && 
      v.status === 'active' &&
      v.strategy &&
      ethers.utils.isAddress(v.strategy)
    );

    log.info(`📊 Found ${polygonVaults.length} active Polygon vaults`);
    
    // Log a sample for debugging
    if (polygonVaults.length > 0) {
      log.debug('Sample vault', {
        id: polygonVaults[0].id,
        chain: polygonVaults[0].chain,
        strategy: polygonVaults[0].strategy,
        status: polygonVaults[0].status,
      });
    }

    return polygonVaults;
  } catch (err) {
    log.error('❌ Failed to fetch Beefy vaults:', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Check if a strategy supports the expected harvest interface
 */
async function strategySupportsHarvest(strategyAddress: string): Promise<boolean> {
  try {
    const contract = new ethers.Contract(strategyAddress, STRATEGY_ABI, provider);
    await contract.callStatic.harvest();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get pending caller reward from the strategy
 */
async function getPendingReward(
  strategyAddress: string,
  executorAddress: string
): Promise<ethers.BigNumber | null> {
  try {
    const contract = new ethers.Contract(strategyAddress, STRATEGY_ABI, provider);
    const earned = await contract.earned(executorAddress);
    return earned;
  } catch {
    return null;
  }
}

/**
 * Simulate a harvest call to ensure it won't revert
 */
async function simulateHarvest(strategyAddress: string, executorAddress: string): Promise<boolean> {
  try {
    const contract = new ethers.Contract(strategyAddress, STRATEGY_ABI, provider);
    await contract.callStatic.harvest({ from: executorAddress });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a token address to our TokenInfo if known
 */
function getTokenInfo(address: string, symbol?: string): TokenInfo {
  for (const [key, token] of Object.entries(TOKENS)) {
    if (token.address.toLowerCase() === address.toLowerCase()) {
      return token;
    }
  }
  return {
    chainId: 137,
    address: address,
    decimals: 18,
    symbol: symbol || 'UNKNOWN',
    name: 'Unknown Token',
  };
}

/**
 * Main discovery function for Beefy harvest opportunities
 */
export async function discoverBeefyHarvestCandidates(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];
  const executorAddress = executionWallet.address;

  log.info('🔍 Starting Beefy harvest discovery...');

  // 1. Fetch vaults
  const vaults = await fetchBeefyVaults();
  if (vaults.length === 0) {
    log.warn('⚠️ No Beefy vaults found');
    return [];
  }

  log.info(`📋 Processing ${vaults.length} vaults...`);

  let checkedCount = 0;
  let supportedCount = 0;
  let rewardFoundCount = 0;
  let profitableCount = 0;

  // Limit to first 50 to avoid rate limits
  const limitedVaults = vaults.slice(0, 50);

  for (const vault of limitedVaults) {
    try {
      checkedCount++;

      const strategyAddress = vault.strategy;
      if (!strategyAddress || !ethers.utils.isAddress(strategyAddress)) {
        log.debug(`Skipping vault ${vault.id}: invalid strategy address`);
        continue;
      }

      // Check if strategy supports harvest
      const hasHarvest = await strategySupportsHarvest(strategyAddress);
      if (!hasHarvest) {
        log.debug(`Skipping vault ${vault.id}: strategy does not support harvest()`);
        continue;
      }
      supportedCount++;

      // Get pending reward for executor
      const rewardAmount = await getPendingReward(strategyAddress, executorAddress);
      if (!rewardAmount || rewardAmount.isZero()) {
        log.debug(`Skipping vault ${vault.id}: no pending reward for executor`);
        continue;
      }
      rewardFoundCount++;

      // Simulate harvest
      const harvestSimSuccess = await simulateHarvest(strategyAddress, executorAddress);
      if (!harvestSimSuccess) {
        log.debug(`Skipping vault ${vault.id}: harvest simulation failed`);
        continue;
      }

      // Determine reward token
      let rewardTokenAddress = vault.earnedTokenAddress;
      if (!rewardTokenAddress || !ethers.utils.isAddress(rewardTokenAddress)) {
        log.debug(`Skipping vault ${vault.id}: cannot determine reward token`);
        continue;
      }

      const rewardToken = getTokenInfo(rewardTokenAddress, vault.earnedToken || 'REWARD');

      // Get reward token price via Enso quote
      const amountIn = rewardAmount.toString();
      const quote = await getEnsoRouteQuote(rewardToken, TOKENS.USDC, amountIn);
      if (!quote) {
        log.debug(`Skipping vault ${vault.id}: Enso quote failed for reward token`);
        continue;
      }

      // Calculate gas cost
      const gasPrice = await provider.getGasPrice();
      let harvestGasEstimate: ethers.BigNumber;
      try {
        const contract = new ethers.Contract(strategyAddress, STRATEGY_ABI, provider);
        harvestGasEstimate = await contract.estimateGas.harvest({ from: executorAddress });
        harvestGasEstimate = harvestGasEstimate.mul(120).div(100);
      } catch {
        harvestGasEstimate = ethers.BigNumber.from(200000);
      }

      const swapGas = ethers.BigNumber.from(quote.raw?.gas || 150000);
      const totalGas = harvestGasEstimate.add(swapGas);
      const gasCostNative = Number(ethers.utils.formatEther(gasPrice.mul(totalGas)));
      const gasCostUsd = gasCostNative * nativePriceUsd;

      // Calculate gross and net profit
      const rewardUsd = Number(ethers.utils.formatUnits(rewardAmount, rewardToken.decimals)) * quote.price;
      const swapCostBps = 10;
      const swapCostUsd = rewardUsd * (swapCostBps / 10000);
      const netProfitUsd = rewardUsd - gasCostUsd - swapCostUsd;

      const minProfit = env.CLASSIC_INCENTIVE_MIN_PROFIT_USD || env.DEFAULT_MIN_PROFIT_USD || 0.05;
      if (netProfitUsd < minProfit) {
        log.debug(`Skipping vault ${vault.id}: net profit $${netProfitUsd.toFixed(4)} below threshold`);
        continue;
      }
      profitableCount++;

      const candidate: OpportunityCandidate = {
        id: `beefy-${vault.id}-${Date.now()}`,
        strategy: 'classicIncentive',
        protocol: 'beefy',
        params: {
          source: 'beefy',
          vaultId: vault.id,
          strategyAddress: strategyAddress,
          rewardToken: rewardToken,
          rewardAmount: rewardAmount.toString(),
          nativePriceUsd,
          gasCostUsd,
          swapCostUsd,
          netProfitUsd,
          quote,
        },
        estimatedGrossProfitUsd: rewardUsd,
        estimatedNetProfitUsd: netProfitUsd,
        estimatedCostUsd: gasCostUsd + swapCostUsd,
        actionPlan: null,
        sourceTimestamp: Date.now(),
      };

      pushCandidate(candidate);
      candidates.push(candidate);

      log.info(`✅ Found Beefy harvest opportunity for ${vault.id}`, {
        strategy: strategyAddress,
        rewardToken: rewardToken.symbol,
        rewardUsd: rewardUsd.toFixed(4),
        netProfitUsd: netProfitUsd.toFixed(4),
        gasCostUsd: gasCostUsd.toFixed(4),
      });

    } catch (err) {
      log.debug(`Error processing vault ${vault.id}: ${String(err)}`);
      continue;
    }
  }

  log.info(`📊 Beefy discovery stats: ${checkedCount} checked, ${supportedCount} supported, ${rewardFoundCount} with rewards, ${profitableCount} profitable`);
  log.info(`📦 Beefy discovery complete: ${candidates.length} candidates found`);

  return candidates;
}