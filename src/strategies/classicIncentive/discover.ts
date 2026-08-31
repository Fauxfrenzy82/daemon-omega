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
  getHarvestTriggeredProtocols,
  getMerklPools,
  getContractInterface,
} from './protocolRegistry';

const log = createLogger('classicIncentive');

// ============================================
// CHECK HARVEST-TRIGGERED PROTOCOLS
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
    // 1. Query Merkl distributor for claimable amount
    // Merkl distributor address is often per-pool; we need to know it.
    // For QuickSwap Gamma, the distributor is usually the pool itself or a separate contract.
    const merklDistributor = pool.address; // or a separate address

    const contract = new ethers.Contract(merklDistributor, [
      'function claimable(address user, address token) view returns (uint256)',
    ], provider);

    const claimable = await contract.claimable(executorAddress, pool.rewardToken.address);
    if (!claimable || claimable.lte(0)) return null;

    // 2. Simulate claim + swap
    const rewardAmount = claimable;
    const simulation = await simulateClaim(pool, rewardAmount, nativePriceUsd);
    if (!simulation.success || simulation.netProfitUsd < env.CLASSIC_INCENTIVE_MIN_PROFIT_USD) {
      return null;
    }

    return createCandidate(pool, 'merkl-claim', rewardAmount, simulation);
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
  // ... same as before – estimate gas, swap, net profit
  // Return { success, deltaBalance, gasCostUsd, swapCostUsd, callerIncentiveUsd, netProfitUsd }
}

async function simulateClaim(
  protocol: ProtocolConfig,
  rewardAmount: ethers.BigNumber,
  nativePriceUsd: number
): Promise<any> {
  // Similar to simulateHarvest, but for Merkl claim
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
      nativePriceUsd: simulation.nativePriceUsd,
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
  const candidates: OpportunityCandidate[] = [];
  const executor = executionWallet.address;

  log.info('🔍 Classic Incentive discovery', { executor, nativePrice: nativePriceUsd });

  // 1. Check harvest-triggered protocols (Beefy, Convex, etc.)
  const harvestProtocols = getHarvestTriggeredProtocols();
  log.info(`📋 Harvest-triggered protocols: ${harvestProtocols.length}`);
  for (const protocol of harvestProtocols) {
    const candidate = await checkHarvestTriggered(protocol, executor, nativePriceUsd);
    if (candidate) {
      pushCandidate(candidate);
      candidates.push(candidate);
    }
  }

  // 2. Check Merkl claimable rewards (Gamma pools)
  const merklPools = getMerklPools();
  log.info(`📋 Merkl pools (for claim checking): ${merklPools.length}`);
  // Limit to top 50 by TVL to avoid overload
  const topPools = merklPools.slice(0, 50);
  for (const pool of topPools) {
    const candidate = await checkMerklClaim(pool, executor, nativePriceUsd);
    if (candidate) {
      pushCandidate(candidate);
      candidates.push(candidate);
    }
  }

  log.info(`📦 Classic Incentive found ${candidates.length} candidates`);
  return candidates;
}