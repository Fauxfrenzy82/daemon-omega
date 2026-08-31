// src/strategies/classicIncentive/discover.ts

import { ethers } from 'ethers';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { provider, executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';
import { pushCandidate } from '../../execution/queue';
import { withRetry, isTransientError } from '../../utils/retry';
import { getLiveTokenPriceUsd } from '../../utils/priceUtils';
import { getEnsoRouteQuote } from '../../scanner/sources/ensoRoute';
import {
  ProtocolConfig,
  getHarvestableProtocols,
  getMerklPools,
  getContractInterface,
} from './protocolRegistry';
// ✅ Import Beefy discovery
import { discoverBeefyHarvestCandidates } from '../../discovery/beefyDiscovery';

const log = createLogger('classicIncentive');

// ============================================
// CHECK HARVEST-TRIGGERED PROTOCOLS (Hardcoded)
// ============================================

async function checkHarvestTriggered(
  protocol: ProtocolConfig,
  executorAddress: string,
  nativePriceUsd: number
): Promise<OpportunityCandidate | null> {
  const contract = new ethers.Contract(protocol.address, protocol.abi || [], provider);

  // Check pending rewards
  const rewardAmount = await checkEarned(contract, executorAddress);
  if (!rewardAmount || rewardAmount.lte(0)) return null;

  // Simulate harvest
  const simulation = await simulateHarvest(protocol, rewardAmount, nativePriceUsd);
  if (!simulation.success || simulation.netProfitUsd < env.CLASSIC_INCENTIVE_MIN_PROFIT_USD) {
    return null;
  }

  return createCandidate(protocol, 'harvest', rewardAmount, simulation);
}

// ============================================
// CHECK MERKL CLAIMABLE REWARDS
// ============================================

async function checkMerklClaim(
  pool: ProtocolConfig,
  executorAddress: string,
  nativePriceUsd: number
): Promise<OpportunityCandidate | null> {
  try {
    // For Merkl, we need the distributor address; currently using pool.address as placeholder
    const merklDistributor = pool.address;

    const contract = new ethers.Contract(merklDistributor, [
      'function claimable(address user, address token) view returns (uint256)',
    ], provider);

    const claimable = await contract.claimable(executorAddress, pool.rewardToken.address);
    if (!claimable || claimable.lte(0)) return null;

    const simulation = await simulateClaim(pool, claimable, nativePriceUsd);
    if (!simulation.success || simulation.netProfitUsd < env.CLASSIC_INCENTIVE_MIN_PROFIT_USD) {
      return null;
    }

    return createCandidate(pool, 'merkl-claim', claimable, simulation);
  } catch (err) {
    log.debug(`Merkl claim check failed for ${pool.id}: ${String(err)}`);
    return null;
  }
}

// ============================================
// HELPER: Check earned on contract
// ============================================

async function checkEarned(contract: ethers.Contract, executor: string): Promise<ethers.BigNumber | null> {
  const methods = ['earned', 'pendingReward', 'pendingRewards', 'claimable_tokens'];
  for (const method of methods) {
    try {
      if (typeof contract[method] === 'function') {
        const result = await contract[method](executor);
        if (result && ethers.BigNumber.isBigNumber(result) && result.gt(0)) {
          return result;
        }
      }
    } catch {}
  }
  return null;
}

// ============================================
// SIMULATE HARVEST / CLAIM
// ============================================

async function simulateHarvest(
  protocol: ProtocolConfig,
  rewardAmount: ethers.BigNumber,
  nativePriceUsd: number
): Promise<any> {
  try {
    const rewardTokenPrice = await getLiveTokenPriceUsd(protocol.rewardToken);
    const rewardUsd = Number(ethers.utils.formatUnits(rewardAmount, protocol.rewardToken.decimals)) * rewardTokenPrice;

    const gasPrice = await provider.getGasPrice();
    const gasEstimate = ethers.BigNumber.from(200000);
    const gasCostNative = Number(ethers.utils.formatEther(gasPrice.mul(gasEstimate)));
    const gasCostUsd = gasCostNative * nativePriceUsd;

    const amountIn = rewardAmount.toString();
    const quote = await getEnsoRouteQuote(protocol.rewardToken, protocol.entryToken, amountIn);

    if (!quote) {
      return { success: false, deltaBalance: 0, gasCostUsd, swapCostUsd: 0, callerIncentiveUsd: 0, netProfitUsd: 0 };
    }

    const swapCostBps = 10;
    const swapCostUsd = rewardUsd * (swapCostBps / 10000);

    let callerIncentiveUsd = rewardUsd;
    if (protocol.callerIncentiveBps) {
      callerIncentiveUsd = rewardUsd * (protocol.callerIncentiveBps / 10000);
    }

    const netProfitUsd = callerIncentiveUsd - gasCostUsd - swapCostUsd;

    return {
      success: netProfitUsd > 0,
      deltaBalance: callerIncentiveUsd,
      gasCostUsd,
      swapCostUsd,
      callerIncentiveUsd,
      netProfitUsd,
    };
  } catch (err) {
    return { success: false, deltaBalance: 0, gasCostUsd: 0, swapCostUsd: 0, callerIncentiveUsd: 0, netProfitUsd: 0 };
  }
}

async function simulateClaim(
  protocol: ProtocolConfig,
  rewardAmount: ethers.BigNumber,
  nativePriceUsd: number
): Promise<any> {
  // Similar to simulateHarvest, but for Merkl claim
  try {
    const rewardTokenPrice = await getLiveTokenPriceUsd(protocol.rewardToken);
    const rewardUsd = Number(ethers.utils.formatUnits(rewardAmount, protocol.rewardToken.decimals)) * rewardTokenPrice;

    const gasPrice = await provider.getGasPrice();
    const gasEstimate = ethers.BigNumber.from(250000);
    const gasCostNative = Number(ethers.utils.formatEther(gasPrice.mul(gasEstimate)));
    const gasCostUsd = gasCostNative * nativePriceUsd;

    const amountIn = rewardAmount.toString();
    const quote = await getEnsoRouteQuote(protocol.rewardToken, protocol.entryToken, amountIn);

    if (!quote) {
      return { success: false, deltaBalance: 0, gasCostUsd, swapCostUsd: 0, callerIncentiveUsd: 0, netProfitUsd: 0 };
    }

    const swapCostBps = 10;
    const swapCostUsd = rewardUsd * (swapCostBps / 10000);

    const netProfitUsd = rewardUsd - gasCostUsd - swapCostUsd;

    return {
      success: netProfitUsd > 0,
      deltaBalance: rewardUsd,
      gasCostUsd,
      swapCostUsd,
      callerIncentiveUsd: rewardUsd,
      netProfitUsd,
    };
  } catch (err) {
    return { success: false, deltaBalance: 0, gasCostUsd: 0, swapCostUsd: 0, callerIncentiveUsd: 0, netProfitUsd: 0 };
  }
}

// ============================================
// CREATE CANDIDATE
// ============================================

function createCandidate(
  protocol: ProtocolConfig,
  actionType: 'harvest' | 'merkl-claim',
  rewardAmount: ethers.BigNumber,
  simulation: any
): OpportunityCandidate {
  return {
    id: `${actionType}-${protocol.id}-${Date.now()}`,
    strategy: 'classicIncentive',
    protocol: protocol.id,
    params: {
      protocol,
      actionType,
      rewardAmount: rewardAmount.toString(),
      rewardToken: protocol.rewardToken,
      entryToken: protocol.entryToken,
      callerIncentiveUsd: simulation.callerIncentiveUsd || simulation.deltaBalance,
      simulation,
    },
    estimatedGrossProfitUsd: simulation.deltaBalance,
    estimatedNetProfitUsd: simulation.netProfitUsd,
    estimatedCostUsd: simulation.gasCostUsd + simulation.swapCostUsd,
    actionPlan: null,
    sourceTimestamp: Date.now(),
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
  // 1. Beefy Harvest Opportunities (Caller Bounty)
  // -------------------------------------------------
  log.info('📡 Running Beefy discovery...');
  const beefyCandidates = await discoverBeefyHarvestCandidates(nativePriceUsd);
  allCandidates.push(...beefyCandidates);

  // -------------------------------------------------
  // 2. Harvest-triggered protocols (Hardcoded fallbacks / env)
  // -------------------------------------------------
  const harvestProtocols = getHarvestableProtocols();
  log.info(`📋 Harvest-triggered protocols: ${harvestProtocols.length}`);
  for (const protocol of harvestProtocols) {
    const candidate = await checkHarvestTriggered(protocol, executor, nativePriceUsd);
    if (candidate) {
      pushCandidate(candidate);
      allCandidates.push(candidate);
    }
  }

  // -------------------------------------------------
  // 3. Merkl claimable rewards (Gamma pools)
  // -------------------------------------------------
  const merklPools = getMerklPools();
  log.info(`📋 Merkl pools (for claim checking): ${merklPools.length}`);
  // Limit to top 50 by TVL to avoid overload
  const topPools = merklPools.slice(0, 50);
  for (const pool of topPools) {
    const candidate = await checkMerklClaim(pool, executor, nativePriceUsd);
    if (candidate) {
      pushCandidate(candidate);
      allCandidates.push(candidate);
    }
  }

  log.info(`📦 Classic Incentive found ${allCandidates.length} total candidates`);
  return allCandidates;
}