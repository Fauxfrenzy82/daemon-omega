// src/strategies/classicIncentive/discover.ts

import { ethers } from 'ethers';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { provider, executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';
import { pushCandidate } from '../../execution/queue';
import { getLiveTokenPriceUsd } from '../../utils/priceUtils';
import { getEnsoRouteQuote } from '../../scanner/sources/ensoRoute';
import { TOKENS } from '../../config/tokens';
import {
  ProtocolConfig,
  getHarvestableProtocols,
  getMerklPools,
} from './protocolRegistry';
import { discoverBeefyHarvestCandidates } from '../../discovery/beefyDiscovery';

const log = createLogger('classicIncentive');

// ============================================
// LP REWARD STRATEGY SIMULATION (Merkl/Gamma)
// ============================================

/**
 * Simulate LP reward claims for Merkl pools
 * This checks if the executor has any claimable rewards
 */
async function simulateLpRewardClaims(
  pools: ProtocolConfig[],
  executorAddress: string,
  nativePriceUsd: number,
  limit: number = 100
): Promise<{
  totalChecked: number;
  hasClaimable: number;
  profitable: number;
  avgGasCostUsd: number;
  avgRewardUsd: number;
  avgNetProfitUsd: number;
  results: any[];
}> {
  log.info(`🧪 Simulating ${Math.min(pools.length, limit)} Merkl pools for LP rewards...`);

  let totalChecked = 0;
  let hasClaimable = 0;
  let profitable = 0;
  let totalGasCost = 0;
  let totalReward = 0;
  let totalNetProfit = 0;
  const results: any[] = [];

  for (const pool of pools.slice(0, limit)) {
    try {
      totalChecked++;

      // Check if the pool has a claimable function
      const contract = new ethers.Contract(pool.address, [
        'function claimable(address user, address token) view returns (uint256)',
      ], provider);

      let claimableAmount: ethers.BigNumber;
      try {
        claimableAmount = await contract.claimable(executorAddress, pool.rewardToken.address);
      } catch {
        // Try alternative: earned(address)
        try {
          const earnedContract = new ethers.Contract(pool.address, [
            'function earned(address) view returns (uint256)',
          ], provider);
          claimableAmount = await earnedContract.earned(executorAddress);
        } catch {
          continue;
        }
      }

      if (!claimableAmount || claimableAmount.isZero()) {
        continue;
      }
      hasClaimable++;

      // Get reward token price via Enso
      const amountIn = claimableAmount.toString();
      const quote = await getEnsoRouteQuote(pool.rewardToken, TOKENS.USDC, amountIn);

      if (!quote) {
        continue;
      }

      // Calculate gas cost for claim + swap
      const gasPrice = await provider.getGasPrice();
      const gasEstimate = ethers.BigNumber.from(300000); // Typical claim gas
      const gasCostNative = Number(ethers.utils.formatEther(gasPrice.mul(gasEstimate.mul(120).div(100))));
      const gasCostUsd = gasCostNative * nativePriceUsd;

      // Calculate profit
      const rewardUsd = Number(ethers.utils.formatUnits(claimableAmount, pool.rewardToken.decimals)) * quote.price;
      const swapCostBps = 10;
      const swapCostUsd = rewardUsd * (swapCostBps / 10000);
      const netProfitUsd = rewardUsd - gasCostUsd - swapCostUsd;

      if (netProfitUsd > env.DEFAULT_MIN_PROFIT_USD) {
        profitable++;
        totalGasCost += gasCostUsd;
        totalReward += rewardUsd;
        totalNetProfit += netProfitUsd;

        results.push({
          poolId: pool.id,
          rewardToken: pool.rewardToken.symbol,
          rewardUsd: rewardUsd.toFixed(4),
          gasCostUsd: gasCostUsd.toFixed(4),
          netProfitUsd: netProfitUsd.toFixed(4),
        });
      }
    } catch (err) {
      // Skip errors
    }
  }

  const avgGasCostUsd = profitable > 0 ? totalGasCost / profitable : 0;
  const avgRewardUsd = profitable > 0 ? totalReward / profitable : 0;
  const avgNetProfitUsd = profitable > 0 ? totalNetProfit / profitable : 0;

  log.info('📊 LP Reward simulation results:', {
    totalChecked,
    hasClaimable,
    profitable,
    avgGasCostUsd: avgGasCostUsd.toFixed(4),
    avgRewardUsd: avgRewardUsd.toFixed(4),
    avgNetProfitUsd: avgNetProfitUsd.toFixed(4),
  });

  return {
    totalChecked,
    hasClaimable,
    profitable,
    avgGasCostUsd,
    avgRewardUsd,
    avgNetProfitUsd,
    results,
  };
}

// ============================================
// MAIN DISCOVERY
// ============================================

export async function discoverClassicIncentive(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const allCandidates: OpportunityCandidate[] = [];
  const executor = executionWallet.address;

  log.info('🔍 Classic Incentive discovery', { executor, nativePrice: nativePriceUsd });

  // -------------------------------------------------
  // 1. Beefy Harvest Opportunities (Multi-Chain)
  // -------------------------------------------------
  log.info('📡 Running Beefy discovery...');
  const beefyCandidates = await discoverBeefyHarvestCandidates(nativePriceUsd);
  allCandidates.push(...beefyCandidates);

  // -------------------------------------------------
  // 2. LP Reward Strategy (Merkl/Gamma on Polygon)
  // -------------------------------------------------
  log.info('📡 Running LP Reward simulation on Polygon...');
  const merklPools = getMerklPools();

  if (merklPools.length > 0) {
    log.info(`📋 Merkl pools available: ${merklPools.length}`);

    const lpResults = await simulateLpRewardClaims(
      merklPools,
      executor,
      nativePriceUsd,
      1000 // Simulate up to 1000 pools
    );

    // Create candidates from profitable LP claims
    for (const result of lpResults.results) {
      const pool = merklPools.find(p => p.id === result.poolId);
      if (!pool) continue;

      const candidate: OpportunityCandidate = {
        id: `merkl-${pool.id}-${Date.now()}`,
        strategy: 'classicIncentive',
        protocol: 'merkl',
        params: {
          source: 'merkl',
          poolId: pool.id,
          rewardToken: pool.rewardToken,
          rewardAmount: '0',
          nativePriceUsd,
          gasCostUsd: parseFloat(result.gasCostUsd),
          swapCostUsd: 0,
          netProfitUsd: parseFloat(result.netProfitUsd),
        },
        estimatedGrossProfitUsd: parseFloat(result.rewardUsd),
        estimatedNetProfitUsd: parseFloat(result.netProfitUsd),
        estimatedCostUsd: parseFloat(result.gasCostUsd),
        actionPlan: null,
        sourceTimestamp: Date.now(),
      };

      pushCandidate(candidate);
      allCandidates.push(candidate);
    }

    log.info(`📊 LP Reward simulation complete: ${lpResults.profitable} profitable claims out of ${lpResults.totalChecked} checked`);
  }

  // -------------------------------------------------
  // 3. Final Summary
  // -------------------------------------------------
  log.info('📊 ===== FINAL DISCOVERY SUMMARY =====');
  log.info(`Total candidates found: ${allCandidates.length}`);
  log.info(`  - Beefy: ${beefyCandidates.length}`);
  log.info(`  - LP Rewards: ${allCandidates.length - beefyCandidates.length}`);

  if (allCandidates.length === 0) {
    log.warn('⚠️ No candidates found - check your configuration and RPC connectivity');
  }

  return allCandidates;
}