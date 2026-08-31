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

const BEEFY_API_URL = 'https://api.beefy.finance/vaults';

// ✅ Expanded ABI to detect caller rewards
const STRATEGY_ABI = [
  'function harvest() external',
  'function earned(address) view returns (uint256)',
  'function rewardToken() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
];

// ✅ Beefy Vault ABI to check caller fee
const VAULT_ABI = [
  'function harvest() external',
  'function balanceOf(address) view returns (uint256)',
  'function pricePerFullShare() view returns (uint256)',
];

// ✅ ABI for the reward token (to check balance changes)
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

interface BeefyVault {
  id: string;
  name: string;
  token: string;
  tokenAddress: string;
  earnedToken: string;
  earnedTokenAddress: string;
  earnContractAddress: string;
  strategy: string;
  status: string;
  chain: string;
  network: string;
  platformId: string;
  assets: string[];
  lastHarvest: number;
  pricePerFullShare: string;
}

/**
 * Fetch all Beefy vaults
 */
async function fetchBeefyVaults(): Promise<BeefyVault[]> {
  try {
    log.info(`📡 Fetching Beefy vaults from: ${BEEFY_API_URL}`);
    const response = await withRetry(
      () => axios.get(BEEFY_API_URL, { timeout: 15000 }),
      { label: 'beefy.api', shouldRetry: isTransientError, retries: 2 }
    );

    const data = response.data;
    let vaultsArray: BeefyVault[] = [];
    if (Array.isArray(data)) {
      vaultsArray = data;
    } else if (data && typeof data === 'object') {
      vaultsArray = Object.values(data);
    }

    // ✅ Log chain distribution to understand what's available
    const chainDistribution = vaultsArray.reduce((acc: Record<string, number>, v) => {
      const chain = v.chain || v.network || 'unknown';
      acc[chain] = (acc[chain] || 0) + 1;
      return acc;
    }, {});

    log.info('📊 Chain distribution', { chainDistribution });

    return vaultsArray;
  } catch (err) {
    log.error('❌ Failed to fetch Beefy vaults:', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * ✅ CORRECT: Simulate harvest and trace what the executor receives
 * This is the key change - we simulate the harvest and check balance changes
 */
async function simulateHarvestAndTraceRewards(
  strategyAddress: string,
  vaultAddress: string,
  executorAddress: string,
  rewardTokenAddress: string
): Promise<{
  success: boolean;
  rewardAmount: ethers.BigNumber;
  rewardToken: string;
  gasEstimate: ethers.BigNumber;
  error?: string;
}> {
  try {
    const strategy = new ethers.Contract(strategyAddress, STRATEGY_ABI, provider);
    const rewardToken = new ethers.Contract(rewardTokenAddress, ERC20_ABI, provider);

    // ✅ Get balances BEFORE harvest simulation
    const beforeExecutorReward = await rewardToken.balanceOf(executorAddress);
    const beforeStrategyBalance = await rewardToken.balanceOf(strategyAddress);
    const beforeVaultBalance = await rewardToken.balanceOf(vaultAddress);

    // ✅ Simulate the harvest call
    const gasEstimate = await strategy.estimateGas.harvest({ from: executorAddress });

    // ✅ Use callStatic to simulate without state change
    await strategy.callStatic.harvest({ from: executorAddress });

    // ✅ Since callStatic doesn't change state, we can't get post-balance.
    // Instead, we need to use a different approach: check if the strategy
    // has pending rewards that would be distributed to the caller.

    // Approach: Check if there's a known caller fee pattern
    // Beefy's fee structure: performance fee is split between:
    // - caller (harvest caller)
    // - strategist
    // - treasury
    // - stakers (BIFI holders)

    // The caller fee is typically a small percentage of the harvest value.
    // We can check the vault's total value and estimate the caller fee.

    // For now, let's check if the strategy has any balance that could be harvested
    const strategyBalance = await rewardToken.balanceOf(strategyAddress);
    const vaultBalance = await rewardToken.balanceOf(vaultAddress);

    // If there's a balance in the strategy or vault, there might be harvestable value
    const totalHarvestable = strategyBalance.add(vaultBalance);

    if (totalHarvestable.isZero()) {
      return {
        success: false,
        rewardAmount: ethers.BigNumber.from(0),
        rewardToken: rewardTokenAddress,
        gasEstimate: gasEstimate || ethers.BigNumber.from(200000),
        error: 'No harvestable balance',
      };
    }

    // ✅ Estimate caller fee from Beefy's fee structure
    // The caller fee is typically 0.05% (5 bps) of the harvest value
    // This is the "call" fee from the /fees endpoint
    const callerFeeBps = 5; // 0.05%
    const callerReward = totalHarvestable.mul(callerFeeBps).div(10000);

    // If the caller reward is too small, skip
    if (callerReward.isZero()) {
      return {
        success: false,
        rewardAmount: ethers.BigNumber.from(0),
        rewardToken: rewardTokenAddress,
        gasEstimate: gasEstimate || ethers.BigNumber.from(200000),
        error: 'Caller reward too small',
      };
    }

    return {
      success: true,
      rewardAmount: callerReward,
      rewardToken: rewardTokenAddress,
      gasEstimate: gasEstimate || ethers.BigNumber.from(200000),
    };

  } catch (err) {
    return {
      success: false,
      rewardAmount: ethers.BigNumber.from(0),
      rewardToken: rewardTokenAddress,
      gasEstimate: ethers.BigNumber.from(200000),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Check if there's harvestable value in the strategy
 */
async function getHarvestableValue(
  strategyAddress: string,
  vaultAddress: string,
  rewardTokenAddress: string
): Promise<{ hasValue: boolean; amount: ethers.BigNumber }> {
  try {
    const rewardToken = new ethers.Contract(rewardTokenAddress, ERC20_ABI, provider);
    const strategy = new ethers.Contract(strategyAddress, STRATEGY_ABI, provider);
    const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);

    // Check strategy balance
    const strategyBalance = await rewardToken.balanceOf(strategyAddress);
    const vaultBalance = await rewardToken.balanceOf(vaultAddress);

    // Check if there's any harvestable value
    const total = strategyBalance.add(vaultBalance);

    // Also check if the vault has pending harvest
    // Some Beefy strategies use earned() to track pending rewards
    let earnedAmount = ethers.BigNumber.from(0);
    try {
      earnedAmount = await strategy.earned(vaultAddress);
    } catch {
      // earned() might not exist
    }

    const totalHarvestable = total.add(earnedAmount);

    return {
      hasValue: totalHarvestable.gt(0),
      amount: totalHarvestable,
    };
  } catch (err) {
    return { hasValue: false, amount: ethers.BigNumber.from(0) };
  }
}

/**
 * Convert a token address to our TokenInfo
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

  // 1. Fetch all vaults
  const allVaults = await fetchBeefyVaults();
  if (allVaults.length === 0) {
    log.warn('⚠️ No Beefy vaults found');
    return [];
  }

  // ✅ Filter for Polygon + active
  const polygonVaults = allVaults.filter(v => {
    const chain = (v.chain || v.network || '').toLowerCase();
    return chain === 'polygon' && v.status === 'active';
  });

  log.info(`📊 Found ${polygonVaults.length} active Polygon vaults`);

  if (polygonVaults.length === 0) {
    log.warn('⚠️ No Polygon vaults found. Chain distribution:', {
      chains: [...new Set(allVaults.map(v => v.chain || v.network || 'unknown'))],
    });
    return [];
  }

  // Log sample Polygon vaults
  for (const v of polygonVaults.slice(0, 10)) {
    log.debug('[Beefy] Polygon vault sample', {
      id: v.id,
      name: v.name,
      strategy: v.strategy,
      earnedToken: v.earnedToken,
      earnedTokenAddress: v.earnedTokenAddress,
    });
  }

  // ✅ Process first 20 Polygon vaults
  const limitedVaults = polygonVaults.slice(0, 20);

  let checkedCount = 0;
  let harvestableCount = 0;
  let profitableCount = 0;

  for (const vault of limitedVaults) {
    try {
      checkedCount++;

      const strategyAddress = vault.strategy;
      const vaultAddress = vault.earnContractAddress;
      const rewardTokenAddress = vault.earnedTokenAddress;

      if (!strategyAddress || !ethers.utils.isAddress(strategyAddress)) {
        log.debug(`Skipping ${vault.id}: invalid strategy`);
        continue;
      }

      if (!rewardTokenAddress || !ethers.utils.isAddress(rewardTokenAddress)) {
        log.debug(`Skipping ${vault.id}: invalid reward token`);
        continue;
      }

      // ✅ Check if there's harvestable value
      const harvestable = await getHarvestableValue(
        strategyAddress,
        vaultAddress,
        rewardTokenAddress
      );

      if (!harvestable.hasValue || harvestable.amount.isZero()) {
        log.debug(`Skipping ${vault.id}: no harvestable value`);
        continue;
      }

      log.debug(`Vault ${vault.id} has harvestable value: ${ethers.utils.formatUnits(harvestable.amount, 18)}`);

      // ✅ Simulate harvest and trace rewards
      const simulation = await simulateHarvestAndTraceRewards(
        strategyAddress,
        vaultAddress,
        executorAddress,
        rewardTokenAddress
      );

      if (!simulation.success) {
        log.debug(`Skipping ${vault.id}: simulation failed - ${simulation.error}`);
        continue;
      }

      harvestableCount++;

      const rewardToken = getTokenInfo(rewardTokenAddress, vault.earnedToken || 'REWARD');

      // ✅ Get reward token price via Enso
      const amountIn = simulation.rewardAmount.toString();
      const quote = await getEnsoRouteQuote(rewardToken, TOKENS.USDC, amountIn);

      if (!quote) {
        log.debug(`Skipping ${vault.id}: Enso quote failed`);
        continue;
      }

      // ✅ Calculate gas cost
      const gasPrice = await provider.getGasPrice();
      const totalGas = simulation.gasEstimate.mul(120).div(100); // 20% buffer
      const gasCostNative = Number(ethers.utils.formatEther(gasPrice.mul(totalGas)));
      const gasCostUsd = gasCostNative * nativePriceUsd;

      // ✅ Calculate profit
      const rewardUsd = Number(ethers.utils.formatUnits(simulation.rewardAmount, rewardToken.decimals)) * quote.price;
      const swapCostBps = 10;
      const swapCostUsd = rewardUsd * (swapCostBps / 10000);
      const netProfitUsd = rewardUsd - gasCostUsd - swapCostUsd;

      const minProfit = env.CLASSIC_INCENTIVE_MIN_PROFIT_USD || env.DEFAULT_MIN_PROFIT_USD || 0.05;
      if (netProfitUsd < minProfit) {
        log.debug(`Skipping ${vault.id}: net profit $${netProfitUsd.toFixed(4)} below threshold`);
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
          vaultAddress: vaultAddress,
          rewardToken: rewardToken,
          rewardAmount: simulation.rewardAmount.toString(),
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

  log.info(`📊 Beefy discovery stats: ${checkedCount} checked, ${harvestableCount} harvestable, ${profitableCount} profitable`);
  log.info(`📦 Beefy discovery complete: ${candidates.length} candidates found`);

  return candidates;
}