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

// ✅ Chain configurations for multi-chain support
const CHAIN_CONFIG: Record<string, { chainId: number; rpcUrl?: string; nativeToken: TokenInfo }> = {
  base: { chainId: 8453, nativeToken: TOKENS.WETH },
  ethereum: { chainId: 1, nativeToken: TOKENS.WETH },
  optimism: { chainId: 10, nativeToken: TOKENS.WETH },
  arbitrum: { chainId: 42161, nativeToken: TOKENS.WETH },
  polygon: { chainId: 137, nativeToken: TOKENS.WMATIC },
  bsc: { chainId: 56, nativeToken: TOKENS.WETH },
};

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
 * Simulate harvest and trace rewards for a vault
 */
async function simulateVaultHarvest(
  vault: BeefyVault,
  executorAddress: string,
  nativePriceUsd: number
): Promise<{
  success: boolean;
  rewardAmount: ethers.BigNumber;
  rewardTokenAddress: string;
  rewardTokenSymbol: string;
  gasEstimate: ethers.BigNumber;
  rewardUsd: number;
  gasCostUsd: number;
  netProfitUsd: number;
  error?: string;
}> {
  try {
    const strategyAddress = vault.strategy;
    const vaultAddress = vault.earnContractAddress;
    const rewardTokenAddress = vault.earnedTokenAddress;

    if (!strategyAddress || !ethers.utils.isAddress(strategyAddress)) {
      return { success: false, rewardAmount: ethers.BigNumber.from(0), rewardTokenAddress: '', rewardTokenSymbol: '', gasEstimate: ethers.BigNumber.from(200000), rewardUsd: 0, gasCostUsd: 0, netProfitUsd: 0, error: 'Invalid strategy' };
    }

    if (!rewardTokenAddress || !ethers.utils.isAddress(rewardTokenAddress)) {
      return { success: false, rewardAmount: ethers.BigNumber.from(0), rewardTokenAddress: '', rewardTokenSymbol: '', gasEstimate: ethers.BigNumber.from(200000), rewardUsd: 0, gasCostUsd: 0, netProfitUsd: 0, error: 'Invalid reward token' };
    }

    const strategy = new ethers.Contract(strategyAddress, STRATEGY_ABI, provider);
    const rewardToken = new ethers.Contract(rewardTokenAddress, ERC20_ABI, provider);

    // Get token decimals and symbol
    let decimals = 18;
    let symbol = 'UNKNOWN';
    try {
      decimals = await rewardToken.decimals();
      symbol = await rewardToken.symbol();
    } catch {}

    // Check harvestable balance
    const strategyBalance = await rewardToken.balanceOf(strategyAddress);
    const vaultBalance = await rewardToken.balanceOf(vaultAddress);
    const totalHarvestable = strategyBalance.add(vaultBalance);

    if (totalHarvestable.isZero()) {
      return { success: false, rewardAmount: ethers.BigNumber.from(0), rewardTokenAddress, rewardTokenSymbol: symbol, gasEstimate: ethers.BigNumber.from(200000), rewardUsd: 0, gasCostUsd: 0, netProfitUsd: 0, error: 'No harvestable balance' };
    }

    // Estimate gas for harvest
    let gasEstimate: ethers.BigNumber;
    try {
      gasEstimate = await strategy.estimateGas.harvest({ from: executorAddress });
      gasEstimate = gasEstimate.mul(120).div(100); // 20% buffer
    } catch {
      gasEstimate = ethers.BigNumber.from(250000);
    }

    // Caller fee: 0.05% (5 bps)
    const callerFeeBps = 5;
    const callerReward = totalHarvestable.mul(callerFeeBps).div(10000);

    if (callerReward.isZero()) {
      return { success: false, rewardAmount: ethers.BigNumber.from(0), rewardTokenAddress, rewardTokenSymbol: symbol, gasEstimate, rewardUsd: 0, gasCostUsd: 0, netProfitUsd: 0, error: 'Caller reward too small' };
    }

    // Get reward token price via Enso
    const rewardTokenInfo = getTokenInfo(rewardTokenAddress, symbol);
    const amountIn = callerReward.toString();
    const quote = await getEnsoRouteQuote(rewardTokenInfo, TOKENS.USDC, amountIn);

    if (!quote) {
      return { success: false, rewardAmount: ethers.BigNumber.from(0), rewardTokenAddress, rewardTokenSymbol: symbol, gasEstimate, rewardUsd: 0, gasCostUsd: 0, netProfitUsd: 0, error: 'Enso quote failed' };
    }

    // Calculate gas cost
    const gasPrice = await provider.getGasPrice();
    const gasCostNative = Number(ethers.utils.formatEther(gasPrice.mul(gasEstimate)));
    const gasCostUsd = gasCostNative * nativePriceUsd;

    // Calculate profit
    const rewardUsd = Number(ethers.utils.formatUnits(callerReward, decimals)) * quote.price;
    const swapCostBps = 10;
    const swapCostUsd = rewardUsd * (swapCostBps / 10000);
    const netProfitUsd = rewardUsd - gasCostUsd - swapCostUsd;

    return {
      success: netProfitUsd > 0,
      rewardAmount: callerReward,
      rewardTokenAddress,
      rewardTokenSymbol: symbol,
      gasEstimate,
      rewardUsd,
      gasCostUsd,
      netProfitUsd,
    };
  } catch (err) {
    return {
      success: false,
      rewardAmount: ethers.BigNumber.from(0),
      rewardTokenAddress: '',
      rewardTokenSymbol: '',
      gasEstimate: ethers.BigNumber.from(200000),
      rewardUsd: 0,
      gasCostUsd: 0,
      netProfitUsd: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Simulate a large number of vaults and return statistics
 */
async function simulateVaultsBatch(
  vaults: BeefyVault[],
  executorAddress: string,
  nativePriceUsd: number,
  chainName: string,
  limit: number = 50
): Promise<{
  chain: string;
  totalTested: number;
  hasHarvest: number;
  hasBalance: number;
  profitable: number;
  avgGasCostUsd: number;
  avgRewardUsd: number;
  avgNetProfitUsd: number;
  maxNetProfitUsd: number;
  minNetProfitUsd: number;
  results: any[];
}> {
  log.info(`🧪 Simulating ${Math.min(vaults.length, limit)} vaults on ${chainName}...`);

  let totalTested = 0;
  let hasHarvest = 0;
  let hasBalance = 0;
  let profitable = 0;
  let totalGasCost = 0;
  let totalReward = 0;
  let totalNetProfit = 0;
  let maxNetProfit = -Infinity;
  let minNetProfit = Infinity;
  const results: any[] = [];

  for (const vault of vaults.slice(0, limit)) {
    try {
      totalTested++;

      // Check if harvest exists
      const strategy = new ethers.Contract(vault.strategy, STRATEGY_ABI, provider);
      let hasHarvestFn = false;
      try {
        await strategy.callStatic.harvest({ from: executorAddress });
        hasHarvestFn = true;
        hasHarvest++;
      } catch {
        continue;
      }

      const simulation = await simulateVaultHarvest(vault, executorAddress, nativePriceUsd);

      if (simulation.success) {
        hasBalance++;
        profitable++;
        totalGasCost += simulation.gasCostUsd;
        totalReward += simulation.rewardUsd;
        totalNetProfit += simulation.netProfitUsd;
        maxNetProfit = Math.max(maxNetProfit, simulation.netProfitUsd);
        minNetProfit = Math.min(minNetProfit, simulation.netProfitUsd);

        results.push({
          id: vault.id,
          name: vault.name,
          rewardToken: simulation.rewardTokenSymbol,
          rewardUsd: simulation.rewardUsd.toFixed(4),
          gasCostUsd: simulation.gasCostUsd.toFixed(4),
          netProfitUsd: simulation.netProfitUsd.toFixed(4),
        });
      }
    } catch (err) {
      // Skip errors
    }
  }

  const avgGasCostUsd = profitable > 0 ? totalGasCost / profitable : 0;
  const avgRewardUsd = profitable > 0 ? totalReward / profitable : 0;
  const avgNetProfitUsd = profitable > 0 ? totalNetProfit / profitable : 0;

  log.info(`📊 ${chainName} simulation results:`, {
    totalTested,
    hasHarvest,
    hasBalance,
    profitable,
    avgGasCostUsd: avgGasCostUsd.toFixed(4),
    avgRewardUsd: avgRewardUsd.toFixed(4),
    avgNetProfitUsd: avgNetProfitUsd.toFixed(4),
    maxNetProfitUsd: maxNetProfit > -Infinity ? maxNetProfit.toFixed(4) : 'N/A',
    minNetProfitUsd: minNetProfit < Infinity ? minNetProfit.toFixed(4) : 'N/A',
  });

  // Log top 5 profitable vaults
  const sorted = [...results].sort((a, b) => parseFloat(b.netProfitUsd) - parseFloat(a.netProfitUsd));
  if (sorted.length > 0) {
    log.info(`🏆 Top 5 profitable vaults on ${chainName}:`);
    for (const r of sorted.slice(0, 5)) {
      log.info(`   ${r.id}: $${r.netProfitUsd} (gas: $${r.gasCostUsd}, reward: $${r.rewardUsd})`);
    }
  }

  return {
    chain: chainName,
    totalTested,
    hasHarvest,
    hasBalance,
    profitable,
    avgGasCostUsd,
    avgRewardUsd,
    avgNetProfitUsd,
    maxNetProfitUsd: maxNetProfit > -Infinity ? maxNetProfit : 0,
    minNetProfitUsd: minNetProfit < Infinity ? minNetProfit : 0,
    results,
  };
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

  // 2. Group by chain
  const vaultsByChain = allVaults.reduce((acc: Record<string, BeefyVault[]>, v) => {
    const chain = v.chain || v.network || 'unknown';
    if (!acc[chain]) acc[chain] = [];
    acc[chain].push(v);
    return acc;
  }, {});

  // 3. Target chains for simulation
  const targetChains = ['base', 'ethereum', 'optimism', 'arbitrum', 'polygon', 'bsc'];

  // 4. Run simulations for each chain
  const allResults: {
    chain: string;
    totalTested: number;
    hasHarvest: number;
    hasBalance: number;
    profitable: number;
    avgGasCostUsd: number;
    avgRewardUsd: number;
    avgNetProfitUsd: number;
    maxNetProfitUsd: number;
    minNetProfitUsd: number;
    results: any[];
  }[] = [];

  for (const chain of targetChains) {
    const chainVaults = (vaultsByChain[chain] || []).filter(v => 
      EXECUTABLE_STATUSES.includes(v.status) && v.strategy
    );

    if (chainVaults.length === 0) {
      log.info(`📭 No executable vaults on ${chain}`);
      continue;
    }

    log.info(`📊 ${chain}: ${chainVaults.length} executable vaults`);

    const result = await simulateVaultsBatch(
      chainVaults,
      executorAddress,
      nativePriceUsd,
      chain,
      50 // Limit to 50 per chain for performance
    );

    allResults.push(result);
  }

  // 5. Summary table
  log.info('📊 ===== BEEFY SIMULATION SUMMARY =====');
  log.info('Chain | Tested | Harvestable | Profitable | Avg Gas | Avg Net Profit');
  log.info('------|--------|-------------|------------|---------|----------------');
  for (const r of allResults) {
    log.info(`${r.chain.padEnd(6)} | ${String(r.totalTested).padEnd(6)} | ${String(r.hasBalance).padEnd(11)} | ${String(r.profitable).padEnd(10)} | $${r.avgGasCostUsd.toFixed(4)} | $${r.avgNetProfitUsd.toFixed(4)}`);
  }

  // 6. Find the best chain
  const bestChain = allResults.reduce((best, current) => 
    current.profitable > best.profitable ? current : best
  , allResults[0]);

  if (bestChain && bestChain.profitable > 0) {
    log.info(`🏆 BEST CHAIN: ${bestChain.chain} with ${bestChain.profitable} profitable vaults, avg net profit $${bestChain.avgNetProfitUsd.toFixed(4)}`);
  } else {
    log.warn('⚠️ No profitable vaults found on any chain');
  }

  // 7. Create candidates from all profitable vaults
  for (const result of allResults) {
    for (const vaultResult of result.results) {
      if (parseFloat(vaultResult.netProfitUsd) > env.CLASSIC_INCENTIVE_MIN_PROFIT_USD) {
        // Find the vault
        const vault = allVaults.find(v => v.id === vaultResult.id);
        if (!vault) continue;

        const rewardToken = getTokenInfo(vault.earnedTokenAddress, vaultResult.rewardToken);

        const candidate: OpportunityCandidate = {
          id: `beefy-${vault.id}-${Date.now()}`,
          strategy: 'classicIncentive',
          protocol: 'beefy',
          params: {
            source: 'beefy',
            vaultId: vault.id,
            strategyAddress: vault.strategy,
            vaultAddress: vault.earnContractAddress,
            rewardToken: rewardToken,
            rewardAmount: '0',
            nativePriceUsd,
            gasCostUsd: parseFloat(vaultResult.gasCostUsd),
            swapCostUsd: 0,
            netProfitUsd: parseFloat(vaultResult.netProfitUsd),
            chain: vault.chain,
          },
          estimatedGrossProfitUsd: parseFloat(vaultResult.rewardUsd),
          estimatedNetProfitUsd: parseFloat(vaultResult.netProfitUsd),
          estimatedCostUsd: parseFloat(vaultResult.gasCostUsd),
          actionPlan: null,
          sourceTimestamp: Date.now(),
        };

        pushCandidate(candidate);
        candidates.push(candidate);
      }
    }
  }

  log.info(`📦 Beefy discovery complete: ${candidates.length} candidates found`);
  return candidates;
}