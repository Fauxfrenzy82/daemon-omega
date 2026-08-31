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

// Beefy API endpoint for Polygon
const BEEFY_API_URL = 'https://api.beefy.finance/config/polygon';

// Beefy vault ABI (minimal)
const STRATEGY_ABI = [
  'function harvest() external',
  'function earned(address) view returns (uint256)',
  'function rewardToken() view returns (address)',
];

// Beefy strategy interface for type safety
interface BeefyVault {
  id: string;
  name: string;
  token: string;
  tokenAddress: string;
  earnedToken: string;
  earnedTokenAddress: string;
  strategy: string;
  status: string; // 'active' or 'eol'
  platformId: string;
  chainId: number;
  lastHarvest: number;
}

/**
 * Fetch active Polygon Beefy vaults from the official API
 */
async function fetchBeefyVaults(): Promise<BeefyVault[]> {
  try {
    log.info('📡 Fetching Beefy Polygon vaults from API...');
    const response = await withRetry(
      () => axios.get<Record<string, BeefyVault>>(BEEFY_API_URL, { timeout: 10000 }),
      { label: 'beefy.api', shouldRetry: isTransientError, retries: 2 }
    );

    const vaults = response.data;
    const activeVaults = Object.values(vaults).filter(
      v => v.status === 'active' && v.chainId === 137 && v.strategy
    );

    log.info(`📊 Found ${activeVaults.length} active Polygon vaults`);
    return activeVaults;
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
    // Check if harvest() exists by calling it statically (will revert if not)
    await contract.callStatic.harvest();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the reward token address from the strategy
 */
async function getRewardToken(strategyAddress: string): Promise<string | null> {
  try {
    const contract = new ethers.Contract(strategyAddress, STRATEGY_ABI, provider);
    const token = await contract.rewardToken();
    return token;
  } catch {
    return null;
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
    // Use eth_call to simulate without changing state
    await contract.callStatic.harvest({ from: executorAddress });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a token address to our TokenInfo if known, else create a placeholder
 */
function getTokenInfo(address: string, symbol?: string): TokenInfo {
  // Check if it's one of our known tokens
  for (const [key, token] of Object.entries(TOKENS)) {
    if (token.address.toLowerCase() === address.toLowerCase()) {
      return token;
    }
  }
  // Fallback: create a dynamic token info (decimals may be unknown; we'll fetch on-chain)
  return {
    chainId: 137,
    address: address,
    decimals: 18, // default, will be updated later
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

  // 2. Process each vault
  for (const vault of vaults) {
    try {
      const strategyAddress = vault.strategy;
      if (!ethers.utils.isAddress(strategyAddress)) {
        log.debug(`Skipping vault ${vault.id}: invalid strategy address`);
        continue;
      }

      // 2a. Check if strategy supports harvest
      const hasHarvest = await strategySupportsHarvest(strategyAddress);
      if (!hasHarvest) {
        log.debug(`Skipping vault ${vault.id}: strategy does not support harvest()`);
        continue;
      }

      // 2b. Get pending reward for executor
      const rewardAmount = await getPendingReward(strategyAddress, executorAddress);
      if (!rewardAmount || rewardAmount.isZero()) {
        log.debug(`Skipping vault ${vault.id}: no pending reward for executor`);
        continue;
      }

      // 2c. Simulate harvest to ensure it succeeds
      const harvestSimSuccess = await simulateHarvest(strategyAddress, executorAddress);
      if (!harvestSimSuccess) {
        log.debug(`Skipping vault ${vault.id}: harvest simulation failed`);
        continue;
      }

      // 2d. Determine reward token
      let rewardTokenAddress = vault.earnedTokenAddress;
      if (!rewardTokenAddress || !ethers.utils.isAddress(rewardTokenAddress)) {
        // Try to get from strategy
        const tokenFromStrategy = await getRewardToken(strategyAddress);
        if (tokenFromStrategy && ethers.utils.isAddress(tokenFromStrategy)) {
          rewardTokenAddress = tokenFromStrategy;
        } else {
          log.debug(`Skipping vault ${vault.id}: cannot determine reward token`);
          continue;
        }
      }

      const rewardToken = getTokenInfo(rewardTokenAddress, vault.earnedToken || 'REWARD');

      // 2e. Get reward token price via Enso quote
      const amountIn = rewardAmount.toString();
      const quote = await getEnsoRouteQuote(rewardToken, TOKENS.USDC, amountIn);
      if (!quote) {
        log.debug(`Skipping vault ${vault.id}: Enso quote failed for reward token`);
        continue;
      }

      // 2f. Calculate gas cost for harvest + swap
      const gasPrice = await provider.getGasPrice();
      // Estimate gas for harvest call (simulate to get gas usage)
      let harvestGasEstimate: ethers.BigNumber;
      try {
        const contract = new ethers.Contract(strategyAddress, STRATEGY_ABI, provider);
        harvestGasEstimate = await contract.estimateGas.harvest({ from: executorAddress });
        // Add 20% buffer
        harvestGasEstimate = harvestGasEstimate.mul(120).div(100);
      } catch {
        // Fallback: use a typical gas value
        harvestGasEstimate = ethers.BigNumber.from(200000);
      }

      // Add gas for swap (estimated via Enso quote if available, else fallback)
      const swapGas = ethers.BigNumber.from(quote.raw?.gas || 150000);
      const totalGas = harvestGasEstimate.add(swapGas);
      const gasCostNative = Number(ethers.utils.formatEther(gasPrice.mul(totalGas)));
      const gasCostUsd = gasCostNative * nativePriceUsd;

      // 2g. Calculate gross and net profit
      const rewardUsd = Number(ethers.utils.formatUnits(rewardAmount, rewardToken.decimals)) * quote.price;
      const swapCostBps = 10; // 0.1% slippage buffer
      const swapCostUsd = rewardUsd * (swapCostBps / 10000);
      const netProfitUsd = rewardUsd - gasCostUsd - swapCostUsd;

      // 2h. If profitable, create candidate
      const minProfit = env.CLASSIC_INCENTIVE_MIN_PROFIT_USD || env.DEFAULT_MIN_PROFIT_USD || 0.05;
      if (netProfitUsd < minProfit) {
        log.debug(`Skipping vault ${vault.id}: net profit $${netProfitUsd.toFixed(4)} below threshold`);
        continue;
      }

      const candidate: OpportunityCandidate = {
        id: `beefy-${vault.id}-${Date.now()}`,
        strategy: 'classicIncentive', // we'll treat it as classic incentive for now
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

      // Push to queue
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

  log.info(`📦 Beefy discovery complete: ${candidates.length} candidates found`);
  return candidates;
}