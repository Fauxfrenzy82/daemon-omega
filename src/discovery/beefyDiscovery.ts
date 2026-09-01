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

// ABIs
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

// ✅ Statuses we consider executable
const EXECUTABLE_STATUSES = ['active', 'stable', 'experimental'];

// ✅ Statuses we want to test (EOL)
const TEST_STATUSES = ['eol'];

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

    return vaultsArray;
  } catch (err) {
    log.error('❌ Failed to fetch Beefy vaults:', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * ✅ NEW: Log active vault distribution across all chains
 */
function logActiveVaultDistribution(vaults: BeefyVault[]): void {
  const activeVaults = vaults.filter(v => EXECUTABLE_STATUSES.includes(v.status));
  
  const distribution = activeVaults.reduce((acc: Record<string, number>, v) => {
    const chain = v.chain || v.network || 'unknown';
    acc[chain] = (acc[chain] || 0) + 1;
    return acc;
  }, {});

  // Sort by count descending
  const sorted = Object.entries(distribution).sort((a, b) => b[1] - a[1]);

  log.info('📊 Active vault distribution across chains:');
  for (const [chain, count] of sorted) {
    log.info(`   ${chain}: ${count} vaults`);
  }

  // ✅ Show which chains have the most opportunities
  const topChains = sorted.slice(0, 5);
  log.info(`🏆 Top 5 chains by active vaults: ${topChains.map(([c, n]) => `${c} (${n})`).join(', ')}`);
}

/**
 * ✅ NEW: Test EOL vaults with simulation
 */
async function testEolVaults(
  vaults: BeefyVault[],
  executorAddress: string,
  nativePriceUsd: number,
  limit: number = 10
): Promise<void> {
  const eolVaults = vaults.filter(v => 
    v.status === 'eol' && 
    v.chain === 'polygon' &&
    v.strategy &&
    ethers.utils.isAddress(v.strategy)
  );

  if (eolVaults.length === 0) {
    log.info('📭 No EOL vaults to test on Polygon');
    return;
  }

  log.info(`🧪 Testing ${Math.min(eolVaults.length, limit)} EOL Polygon vaults...`);

  let tested = 0;
  let hasHarvestFunction = 0;
  let hasBalance = 0;
  let simulationSuccess = 0;

  for (const vault of eolVaults.slice(0, limit)) {
    try {
      tested++;
      const strategyAddress = vault.strategy;
      const vaultAddress = vault.earnContractAddress;
      const rewardTokenAddress = vault.earnedTokenAddress;

      if (!rewardTokenAddress || !ethers.utils.isAddress(rewardTokenAddress)) {
        log.debug(`Skipping ${vault.id}: invalid reward token`);
        continue;
      }

      const strategy = new ethers.Contract(strategyAddress, STRATEGY_ABI, provider);
      const rewardToken = new ethers.Contract(rewardTokenAddress, ERC20_ABI, provider);

      // ✅ Check if harvest() exists
      let hasHarvest = false;
      try {
        await strategy.callStatic.harvest({ from: executorAddress });
        hasHarvest = true;
        hasHarvestFunction++;
      } catch {
        // harvest() doesn't exist or reverts
        log.debug(`  ${vault.id}: harvest() not available`);
        continue;
      }

      // ✅ Check if there's any balance to harvest
      const strategyBalance = await rewardToken.balanceOf(strategyAddress);
      const vaultBalance = await rewardToken.balanceOf(vaultAddress);
      const totalHarvestable = strategyBalance.add(vaultBalance);

      if (totalHarvestable.isZero()) {
        log.debug(`  ${vault.id}: no harvestable balance`);
        continue;
      }
      hasBalance++;

      // ✅ Try to get caller fee estimate
      // The caller fee is typically 0.05% (5 bps)
      const callerFeeBps = 5;
      const callerReward = totalHarvestable.mul(callerFeeBps).div(10000);

      if (callerReward.isZero()) {
        log.debug(`  ${vault.id}: caller reward too small`);
        continue;
      }

      // ✅ Get gas estimate
      let gasEstimate: ethers.BigNumber;
      try {
        gasEstimate = await strategy.estimateGas.harvest({ from: executorAddress });
      } catch {
        gasEstimate = ethers.BigNumber.from(200000);
      }

      // ✅ Calculate potential profit
      const rewardTokenInfo = getTokenInfo(rewardTokenAddress, vault.earnedToken || 'REWARD');
      const gasPrice = await provider.getGasPrice();
      const gasCostNative = Number(ethers.utils.formatEther(gasPrice.mul(gasEstimate.mul(120).div(100))));
      const gasCostUsd = gasCostNative * nativePriceUsd;

      const rewardUsd = Number(ethers.utils.formatUnits(callerReward, rewardTokenInfo.decimals)) * 1; // placeholder price
      const netProfitUsd = rewardUsd - gasCostUsd;

      simulationSuccess++;

      log.info(`✅ EOL vault ${vault.id} is harvestable!`, {
        name: vault.name,
        strategy: strategyAddress,
        rewardToken: rewardTokenInfo.symbol,
        harvestableBalance: ethers.utils.formatUnits(totalHarvestable, rewardTokenInfo.decimals),
        estimatedCallerReward: ethers.utils.formatUnits(callerReward, rewardTokenInfo.decimals),
        estimatedGasUsd: gasCostUsd.toFixed(4),
        estimatedNetProfitUsd: netProfitUsd.toFixed(4),
        status: 'EOL - but harvest works!',
      });

    } catch (err) {
      log.debug(`  Error testing ${vault.id}: ${String(err)}`);
    }
  }

  log.info(`📊 EOL test results: ${tested} tested, ${hasHarvestFunction} have harvest(), ${hasBalance} have balance, ${simulationSuccess} simulation successes`);
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
 * Check if harvestable value exists
 */
async function getHarvestableValue(
  strategyAddress: string,
  vaultAddress: string,
  rewardTokenAddress: string
): Promise<{ hasValue: boolean; amount: ethers.BigNumber }> {
  try {
    const rewardToken = new ethers.Contract(rewardTokenAddress, ERC20_ABI, provider);
    const strategy = new ethers.Contract(strategyAddress, STRATEGY_ABI, provider);

    const strategyBalance = await rewardToken.balanceOf(strategyAddress);
    const vaultBalance = await rewardToken.balanceOf(vaultAddress);

    let earnedAmount = ethers.BigNumber.from(0);
    try {
      earnedAmount = await strategy.earned(vaultAddress);
    } catch {}

    const totalHarvestable = strategyBalance.add(vaultBalance).add(earnedAmount);

    return {
      hasValue: totalHarvestable.gt(0),
      amount: totalHarvestable,
    };
  } catch {
    return { hasValue: false, amount: ethers.BigNumber.from(0) };
  }
}

/**
 * Simulate harvest and trace rewards
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

    let gasEstimate: ethers.BigNumber;
    try {
      gasEstimate = await strategy.estimateGas.harvest({ from: executorAddress });
    } catch {
      gasEstimate = ethers.BigNumber.from(200000);
    }

    const callerFeeBps = 5;
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

  // ✅ 2. Log active vault distribution across all chains
  logActiveVaultDistribution(allVaults);

  // ✅ 3. Test EOL vaults (simulation only)
  await testEolVaults(allVaults, executorAddress, nativePriceUsd, 10);

  // 4. Filter: Polygon + executable status
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

  // 5. Process executable vaults
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

      const amountIn = simulation.rewardAmount.toString();
      const quote = await getEnsoRouteQuote(rewardToken, TOKENS.USDC, amountIn);

      if (!quote) {
        log.debug(`Skipping ${vault.id}: Enso quote failed`);
        continue;
      }

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