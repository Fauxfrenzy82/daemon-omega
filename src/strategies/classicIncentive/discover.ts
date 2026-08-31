// src/strategies/classicIncentive/discover.ts

import { ethers } from 'ethers';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { TokenInfo, TOKENS } from '../../config/tokens';
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
  getContractInterface,
  isHarvestLikeFunction,
  isHarvestable,
  createGammaProtocol,
  createFarmProtocol,
} from './protocolRegistry';
import { discoverGammaFarms } from '../../config/farmDiscovery';

const log = createLogger('classicIncentive');

interface HarvestCandidate {
  protocol: ProtocolConfig;
  functionName: string;
  functionSignature: string;
  rewardAmount: ethers.BigNumber;
  rewardToken: TokenInfo;
  rewardUsd: number;
  gasCostUsd: number;
  flashloanFeeUsd: number;
  swapCostUsd: number;
  callerIncentiveUsd: number;
  netProfitUsd: number;
  simulationData: any;
}

// ============================================
// STEP 1: DYNAMIC PROTOCOL DISCOVERY
// ============================================

async function discoverProtocols(): Promise<ProtocolConfig[]> {
  const protocols: ProtocolConfig[] = [];

  // 1. Add hardcoded harvestable protocols
  for (const p of getHarvestableProtocols()) {
    // Skip if address is not set for optional protocols
    if (p.id.startsWith('beefy') && !ethers.utils.isAddress(p.address)) continue;
    if (p.id === 'convex-rewards' && !ethers.utils.isAddress(p.address)) continue;
    if (p.id === 'harvest-finance' && !ethers.utils.isAddress(p.address)) continue;
    protocols.push(p);
  }

  // 2. Discover Gamma farms dynamically
  try {
    log.info('🔍 Discovering Gamma farms from subgraph...');
    const gammaFarms = await discoverGammaFarms();
    
    for (const [pairId, address] of Object.entries(gammaFarms)) {
      if (!ethers.utils.isAddress(address)) continue;
      
      let rewardToken = TOKENS.QUICK;
      let entryToken = TOKENS.USDC;
      
      if (pairId.includes('WETH')) rewardToken = TOKENS.WETH;
      else if (pairId.includes('WBTC')) rewardToken = TOKENS.WBTC;
      else if (pairId.includes('WMATIC')) rewardToken = TOKENS.WMATIC;
      else if (pairId.includes('AAVE')) rewardToken = TOKENS.AAVE;
      
      const protocol = createGammaProtocol(pairId, address, rewardToken, entryToken);
      protocols.push(protocol);
      log.info(`✅ Discovered Gamma farm: ${pairId} -> ${address}`);
    }
  } catch (err) {
    log.warn('Failed to discover Gamma farms', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Discover QuickSwap farms
  try {
    const farmAddress = env.QUICKSWAP_FARM_ADDRESS;
    if (farmAddress && ethers.utils.isAddress(farmAddress)) {
      const protocol = createFarmProtocol('main', farmAddress, TOKENS.QUICK, TOKENS.USDC);
      protocols.push(protocol);
      log.info(`✅ Added QuickSwap farm: ${farmAddress}`);
    }
  } catch (err) {
    log.debug('QuickSwap farm discovery skipped', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const harvestable = protocols.filter(p => isHarvestable(p));
  log.info(`📋 Total harvestable protocols: ${harvestable.length}`);
  return harvestable;
}

// ============================================
// STEP 2: ON-CHAIN STATE CHECK
// ============================================

async function checkPendingRewards(
  protocol: ProtocolConfig,
  executorAddress: string
): Promise<{ hasRewards: boolean; rewardAmount: ethers.BigNumber; rewardToken: TokenInfo }> {
  try {
    const contract = new ethers.Contract(protocol.address, protocol.abi || [], provider);
    
    const checkFunctions = [
      { name: 'earned', args: [executorAddress] },
      { name: 'pendingReward', args: [0, executorAddress] },
      { name: 'pendingRewards', args: [executorAddress] },
      { name: 'claimable_tokens', args: [executorAddress] },
      { name: 'claimable_reward', args: [executorAddress] },
      { name: 'balanceOf', args: [executorAddress] },
    ];

    for (const fn of checkFunctions) {
      try {
        if (typeof contract[fn.name] !== 'function') continue;
        
        const result = await withRetry(
          () => contract[fn.name](...fn.args),
          { label: `checkRewards.${protocol.id}.${fn.name}`, shouldRetry: isTransientError, retries: 2 }
        );

        // ✅ FIXED: Use BigNumber.isBigNumber() instead of _isBigNumber
        if (result && ethers.BigNumber.isBigNumber(result)) {
          const amount = result as ethers.BigNumber;
          if (amount.gt(0)) {
            log.debug(`Found rewards for ${protocol.id} via ${fn.name}`, {
              amount: ethers.utils.formatUnits(amount, protocol.rewardToken.decimals),
            });
            return {
              hasRewards: true,
              rewardAmount: amount,
              rewardToken: protocol.rewardToken,
            };
          }
        }
      } catch (err) {
        continue;
      }
    }

    // Special case: Beefy
    if (protocol.id.startsWith('beefy')) {
      try {
        const strategy = await contract.strategy();
        if (strategy && strategy !== ethers.constants.AddressZero) {
          const strategyContract = new ethers.Contract(strategy, [
            'function balanceOf(address) view returns (uint256)',
          ], provider);
          const balance = await strategyContract.balanceOf(protocol.address);
          if (balance.gt(0)) {
            const performanceFee = await contract.performanceFee?.() || 0;
            const callerShare = performanceFee * (protocol.callerIncentiveBps || 200) / 10000;
            const rewardAmount = balance.mul(callerShare).div(10000);
            if (rewardAmount.gt(0)) {
              return {
                hasRewards: true,
                rewardAmount: rewardAmount,
                rewardToken: protocol.rewardToken,
              };
            }
          }
        }
      } catch (err) {
        log.debug(`Beefy special check failed for ${protocol.id}`);
      }
    }

    return {
      hasRewards: false,
      rewardAmount: ethers.BigNumber.from(0),
      rewardToken: protocol.rewardToken,
    };
  } catch (err) {
    log.debug(`Failed to check rewards for ${protocol.id}`);
    return {
      hasRewards: false,
      rewardAmount: ethers.BigNumber.from(0),
      rewardToken: protocol.rewardToken,
    };
  }
}

// ============================================
// STEP 3: SIMULATE EXECUTION
// ============================================

async function simulateHarvest(
  protocol: ProtocolConfig,
  functionName: string,
  executorAddress: string,
  rewardAmount: ethers.BigNumber,
  rewardToken: TokenInfo,
  nativePriceUsd: number
): Promise<{
  success: boolean;
  deltaBalance: number;
  gasCostUsd: number;
  swapCostUsd: number;
  callerIncentiveUsd: number;
  netProfitUsd: number;
  error?: string;
}> {
  try {
    const rewardTokenPrice = await getLiveTokenPriceUsd(rewardToken);
    const rewardUsd = Number(ethers.utils.formatUnits(rewardAmount, rewardToken.decimals)) * rewardTokenPrice;

    const gasPrice = await provider.getGasPrice();
    const iface = getContractInterface(protocol);
    const fn = protocol.functions.find(f => f.name === functionName);
    if (!fn) {
      return { success: false, deltaBalance: 0, gasCostUsd: 0, swapCostUsd: 0, callerIncentiveUsd: 0, netProfitUsd: 0, error: 'Function not found' };
    }

    let callData: string;
    try {
      callData = iface.encodeFunctionData(fn.name, []);
    } catch {
      try {
        callData = iface.encodeFunctionData(fn.name, [executorAddress]);
      } catch {
        return { success: false, deltaBalance: 0, gasCostUsd: 0, swapCostUsd: 0, callerIncentiveUsd: 0, netProfitUsd: 0, error: 'Cannot encode function' };
      }
    }

    let gasEstimate: ethers.BigNumber;
    try {
      gasEstimate = await provider.estimateGas({
        to: protocol.address,
        data: callData,
        from: executorAddress,
      });
      gasEstimate = gasEstimate.mul(120).div(100);
    } catch {
      gasEstimate = ethers.BigNumber.from(200000);
    }

    const gasCostNative = Number(ethers.utils.formatEther(gasPrice.mul(gasEstimate)));
    const gasCostUsd = gasCostNative * nativePriceUsd;

    const amountIn = rewardAmount.toString();
    const quote = await getEnsoRouteQuote(rewardToken, protocol.entryToken, amountIn);

    if (!quote) {
      return { success: false, deltaBalance: 0, gasCostUsd, swapCostUsd: 0, callerIncentiveUsd: 0, netProfitUsd: 0, error: 'Failed to get swap quote' };
    }

    const swapCostBps = 10;
    const swapCostUsd = rewardUsd * (swapCostBps / 10000);

    let callerIncentiveUsd = rewardUsd;
    if (protocol.callerIncentiveBps) {
      callerIncentiveUsd = rewardUsd * (protocol.callerIncentiveBps / 10000);
    }

    const flashloanFeeUsd = 0;
    const netProfitUsd = callerIncentiveUsd - gasCostUsd - swapCostUsd - flashloanFeeUsd;

    return {
      success: netProfitUsd > 0,
      deltaBalance: callerIncentiveUsd,
      gasCostUsd,
      swapCostUsd,
      callerIncentiveUsd,
      netProfitUsd,
    };
  } catch (err) {
    return {
      success: false,
      deltaBalance: 0,
      gasCostUsd: 0,
      swapCostUsd: 0,
      callerIncentiveUsd: 0,
      netProfitUsd: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================
// STEP 4: MAIN DISCOVERY FUNCTION
// ============================================

export async function discoverClassicIncentive(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];
  const executorAddress = executionWallet.address;

  log.info('🔍 Classic Incentive discovery (harvest-triggered only)', {
    executorAddress,
    nativePrice: nativePriceUsd,
  });

  const protocols = await discoverProtocols();

  if (protocols.length === 0) {
    log.warn('⚠️ No harvestable protocols discovered');
    return [];
  }

  const sortedProtocols = [...protocols].sort((a, b) => a.priority - b.priority);

  for (const protocol of sortedProtocols) {
    try {
      if (!ethers.utils.isAddress(protocol.address) || protocol.address === ethers.constants.AddressZero) {
        continue;
      }

      const rewardCheck = await checkPendingRewards(protocol, executorAddress);

      if (!rewardCheck.hasRewards || rewardCheck.rewardAmount.lte(0)) {
        continue;
      }

      log.info(`Found rewards for ${protocol.id}`, {
        rewardAmount: ethers.utils.formatUnits(rewardCheck.rewardAmount, rewardCheck.rewardToken.decimals),
        rewardToken: rewardCheck.rewardToken.symbol,
      });

      for (const fn of protocol.functions) {
        if (!isHarvestLikeFunction(fn.name)) continue;

        const simulation = await simulateHarvest(
          protocol,
          fn.name,
          executorAddress,
          rewardCheck.rewardAmount,
          rewardCheck.rewardToken,
          nativePriceUsd
        );

        if (!simulation.success) {
          log.debug(`Simulation failed for ${protocol.id}.${fn.name}`, {
            netProfit: simulation.netProfitUsd,
            error: simulation.error,
          });
          continue;
        }

        const minProfit = env.CLASSIC_INCENTIVE_MIN_PROFIT_USD || env.DEFAULT_MIN_PROFIT_USD || 0.05;
        if (simulation.netProfitUsd < minProfit) {
          log.debug(`Net profit ${simulation.netProfitUsd.toFixed(4)} below threshold ${minProfit}`);
          continue;
        }

        const candidate: OpportunityCandidate = {
          id: `harvest-${protocol.id}-${fn.name}-${Date.now()}`,
          strategy: 'classicIncentive',
          protocol: protocol.id,
          params: {
            protocol: protocol,
            functionName: fn.name,
            functionSignature: fn.signature,
            rewardAmount: rewardCheck.rewardAmount.toString(),
            rewardToken: rewardCheck.rewardToken,
            entryToken: protocol.entryToken,
            callerIncentiveUsd: simulation.callerIncentiveUsd,
            nativePriceUsd,
            simulation: simulation,
          },
          estimatedGrossProfitUsd: simulation.deltaBalance,
          estimatedNetProfitUsd: simulation.netProfitUsd,
          estimatedCostUsd: simulation.gasCostUsd + simulation.swapCostUsd,
          actionPlan: null,
          sourceTimestamp: Date.now(),
        };

        pushCandidate(candidate);
        candidates.push(candidate);

        log.info(`✅ Found harvest opportunity for ${protocol.id}`, {
          functionName: fn.name,
          rewardToken: rewardCheck.rewardToken.symbol,
          rewardUsd: simulation.deltaBalance.toFixed(4),
          netProfitUsd: simulation.netProfitUsd.toFixed(4),
        });

        break;
      }
    } catch (err) {
      log.debug(`Protocol check failed for ${protocol.id}`);
    }
  }

  if (candidates.length === 0) {
    log.info('📭 Classic Incentive found 0 harvest opportunities this cycle');
  } else {
    log.info(`📦 Classic Incentive found ${candidates.length} harvest opportunities`);
  }

  return candidates;
}