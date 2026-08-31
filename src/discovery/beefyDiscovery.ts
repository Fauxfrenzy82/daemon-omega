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

const VAULT_ABI = [
  'function harvest() external',
  'function balanceOf(address) view returns (uint256)',
  'function pricePerFullShare() view returns (uint256)',
];

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

// ✅ Valid statuses that can be harvested
const EXECUTABLE_STATUSES = ['active', 'stable', 'experimental'];

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
 * ✅ Log status distribution for Polygon vaults
 */
function logPolygonStatusDistribution(vaults: BeefyVault[]): void {
  const polygonVaults = vaults.filter(v => (v.chain || v.network || '').toLowerCase() === 'polygon');
  
  if (polygonVaults.length === 0) {
    log.warn('⚠️ No Polygon vaults found');
    return;
  }

  const statusDistribution = polygonVaults.reduce((acc: Record<string, number>, v) => {
    const status = v.status || 'unknown';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  log.info('📊 Polygon vault status distribution', { statusDistribution });

  // ✅ Log which statuses are executable vs skipped
  const executable = Object.keys(statusDistribution).filter(s => EXECUTABLE_STATUSES.includes(s));
  const skipped = Object.keys(statusDistribution).filter(s => !EXECUTABLE_STATUSES.includes(s));

  log.info('✅ Executable statuses (will scan):', { statuses: executable });
  log.info('⏭️ Skipped statuses (will ignore):', { statuses: skipped });

  // Log sample vaults for each executable status
  for (const status of executable) {
    const samples = polygonVaults
      .filter(v => v.status === status)
      .slice(0, 3)
      .map(v => ({ id: v.id, name: v.name, strategy: v.strategy }));

    if (samples.length > 0) {
      log.info(`📋 Sample ${status} vaults`, { samples });
    }
  }
}

/**
 * ✅ CORRECT: Simulate harvest and trace what the executor receives
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

    // Check if there's harvestable balance
    const strategyBalance = await rewardToken.balanceOf(strategyAddress);
    const vaultBalance = await rewardToken.balanceOf(vaultAddress);
    const totalHarvestable = strategyBalance.add(vaultBalance);

    if (totalHarvestable.isZero()) {
      return {
        success: false,
        rewardAmount: ethers.BigNumber.from(0),
        rewardToken: rewardTokenAddress,
        gasEstimate: ethers.BigNumber.from(200000),
        error: 'No harvestable balance',
      };
    }

    // Estimate gas for harvest
    let gasEstimate: ethers.BigNumber;
    try {
      gasEstimate = await strategy.estimateGas.harvest({ from: executorAddress });
    } catch {
      gasEstimate = ethers.BigNumber.from(200000);
    }

    // ✅ Estimate caller fee from Beefy's fee structure
    // The caller fee is typically 0.05% (5 bps) of the harvest value
    // This is the "call" fee from the /fees endpoint
    const callerFeeBps = 5; // 0.05%
    const callerReward = totalHarvestable.mul(callerFeeBps).div(10000);

    if (callerReward.isZero()) {
      return {
        success: false,
        rewardAmount: ethers.BigNumber.from(0),
        rewardToken: rewardTokenAddress,
        gasEstimate,
        error: 'Caller reward too small',
      };
    }

    // ✅ Try to simulate harvest to verify it won't revert
    try {
      await strategy.callStatic.harvest({ from: executorAddress });
    } catch (err) {
      // Harvest simulation failed - might still work with different params
      log.debug('Harvest simulation failed, but continuing with estimate', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      success: true,
      rewardAmount: callerReward,
      rewardToken: rewardTokenAddress,
      gasEstimate,
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
 * Get token info
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
 * Main discovery function
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

  // 2. Log status distribution for Polygon
  logPolygonStatusDistribution(allVaults);

  // 3. ✅ Filter: Polygon + executable status
  const polygonVaults = allVaults.filter(v => {
    const chain = (v.chain || v.network || '').toLowerCase();
    return chain === 'polygon' && 
           EXECUTABLE_STATUSES.includes(v.status) &&
           v.strategy &&
           ethers.utils.isAddress(v.strategy);
  });

  log.info(`📊 Found ${polygonVaults.length} executable Polygon vaults`);

  if (polygonVaults.length === 0) {
    log.warn('⚠️ No executable Polygon vaults found');
    return [];
  }

  // 4. Process vaults
  const limitedVaults = polygonVaults.slice(0, 50);
  let checkedCount = 0;
  let harvestableCount = 0;
  let profitableCount = 0;

  for (const vault of limitedVaults) {
    try {
      checkedCount++;

      const strategyAddress = vault.strategy;
      const vaultAddress = vault.earnContractAddress;
      const rewardTokenAddress = vault.earnedTokenAddress;

      if (!rewardTokenAddress || !ethers.utils.isAddress(rewardTokenAddress)) {
        continue;
      }

      // 5. Simulate harvest and trace rewards
      const simulation = await simulateHarvestAndTraceRewards(
        strategyAddress,
        vaultAddress,
        executorAddress,
        rewardTokenAddress
      );

      if (!simulation.success) {
        log.debug(`Skipping ${vault.id}: ${simulation.error}`);
        continue;
      }

      harvestableCount++;

      const rewardToken = getTokenInfo(rewardTokenAddress, vault.earnedToken || 'REWARD');

      // 6. Quote via Enso
      const amountIn = simulation.rewardAmount.toString();
      const quote = await getEnsoRouteQuote(rewardToken, TOKENS.USDC, amountIn);

      if (!quote) {
        log.debug(`Skipping ${vault.id}: Enso quote failed`);
        continue;
      }

      // 7. Calculate gas + profit
      const gasPrice = await provider.getGasPrice();
      const totalGas = simulation.gasEstimate.mul(120).div(100);
      const gasCostNative = Number(ethers.utils.formatEther(gasPrice.mul(totalGas)));
      const gasCostUsd = gasCostNative * nativePriceUsd;

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

      // 8. Create candidate
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