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
  HARVESTABLE_PROTOCOLS,
  ProtocolConfig, 
  getContractInterface,
  isHarvestLikeFunction,
  isHarvestable,
  createGammaProtocol,
  createFarmProtocol,
} from './protocolRegistry';
import { discoverGammaFarms } from '../../config/farmDiscovery';

const log = createLogger('classicIncentive');

// ============================================
// TYPES
// ============================================

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

/**
 * Discover all harvestable protocols dynamically
 * - Priority 1: Hardcoded + Gamma farms from subgraph + QuickSwap farms
 * - Priority 2: Hardcoded (Convex, Harvest Finance)
 */
async function discoverProtocols(): Promise<ProtocolConfig[]> {
  const protocols: ProtocolConfig[] = [];

  // 1. Add hardcoded harvestable protocols
  for (const p of HARVESTABLE_PROTOCOLS) {
    // Skip Beefy if address not set
    if (p.id.startsWith('beefy') && !ethers.utils.isAddress(p.address)) {
      continue;
    }
    // Skip Convex if address not set
    if (p.id === 'convex-rewards' && !ethers.utils.isAddress(p.address)) {
      continue;
    }
    // Skip Harvest Finance if address not set
    if (p.id === 'harvest-finance' && !ethers.utils.isAddress(p.address)) {
      continue;
    }
    protocols.push(p);
  }

  // 2. Discover Gamma farms dynamically (Priority 1)
  try {
    log.info('🔍 Discovering Gamma farms from subgraph...');
    const gammaFarms = await discoverGammaFarms();
    
    for (const [pairId, address] of Object.entries(gammaFarms)) {
      if (!ethers.utils.isAddress(address)) continue;
      
      // Determine reward token from pair
      let rewardToken = TOKENS.QUICK;
      let entryToken = TOKENS.USDC;
      
      if (pairId.includes('WETH')) {
        rewardToken = TOKENS.WETH;
      } else if (pairId.includes('WBTC')) {
        rewardToken = TOKENS.WBTC;
      } else if (pairId.includes('WMATIC')) {
        rewardToken = TOKENS.WMATIC;
      } else if (pairId.includes('AAVE')) {
        rewardToken = TOKENS.AAVE;
      }
      
      const protocol = createGammaProtocol(pairId, address, rewardToken, entryToken);
      protocols.push(protocol);
      log.info(`✅ Discovered Gamma farm: ${pairId} -> ${address}`);
    }
  } catch (err) {
    log.warn('Failed to discover Gamma farms', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Discover QuickSwap farms (from subgraph or hardcoded)
  try {
    // This would come from the subgraph - placeholder for now
    // In production, fetch from QuickSwap subgraph
    const farmAddress = process.env.QUICKSWAP_FARM_ADDRESS;
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

  // Filter to only harvestable protocols
  const harvestable = protocols.filter(p => isHarvestable(p));
  
  log.info(`📋 Total harvestable protocols: ${harvestable.length}`, {
    protocols: harvestable.map(p => `${p.id} (${p.rewardType})`),
  });

  return harvestable;
}

// ============================================
// STEP 2: ON-CHAIN STATE CHECK
// ============================================

/**
 * Check if a protocol has pending rewards for the executor
 */
async function checkPendingRewards(
  protocol: ProtocolConfig,
  executorAddress: string
): Promise<{ hasRewards: boolean; rewardAmount: ethers.BigNumber; rewardToken: TokenInfo }> {
  try {
    const contract = new ethers.Contract(protocol.address, protocol.abi || [], provider);
    
    // Try common reward-checking functions
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
        const result = await withRetry(
          () => {
            // Check if function exists on contract
            if (typeof contract[fn.name] !== 'function') {
              throw new Error(`Function ${fn.name} not found`);
            }
            return contract[fn.name](...fn.args);
          },
          { 
            label: `checkRewards.${protocol.id}.${fn.name}`, 
            shouldRetry: isTransientError, 
            retries: 2 
          }
        );

        if (result && typeof result === 'object' && result._isBigNumber) {
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
        // Function may not exist or may have different signature
        continue;
      }
    }

    // Special case: Beefy - check if there's harvestable value
    if (protocol.id.startsWith('beefy')) {
      try {
        // Check strategy balance that could be harvested
        const strategy = await contract.strategy();
        if (strategy && strategy !== ethers.constants.AddressZero) {
          const strategyContract = new ethers.Contract(strategy, [
            'function balanceOf(address) view returns (uint256)',
          ], provider);
          const balance = await strategyContract.balanceOf(protocol.address);
          if (balance.gt(0)) {
            // There's value to harvest - estimate caller reward
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
        log.debug(`Beefy special check failed for ${protocol.id}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      hasRewards: false,
      rewardAmount: ethers.BigNumber.from(0),
      rewardToken: protocol.rewardToken,
    };
  } catch (err) {
    log.debug(`Failed to check rewards for ${protocol.id}`, {
      error: err instanceof Error ? err.message : String(err),
    });
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

/**
 * Simulate the exact state transition:
 * Δexecutor_balance - Δgas - Δswap_costs
 */
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
    // 1. Get reward value in USD
    const rewardTokenPrice = await getLiveTokenPriceUsd(rewardToken);
    const rewardUsd = Number(ethers.utils.formatUnits(rewardAmount, rewardToken.decimals)) * rewardTokenPrice;

    // 2. Estimate gas cost
    const gasPrice = await provider.getGasPrice();
    const gasPriceGwei = Number(ethers.utils.formatUnits(gasPrice, 'gwei'));

    // Build call data for gas estimation
    const iface = getContractInterface(protocol);
    const fn = protocol.functions.find(f => f.name === functionName);
    if (!fn) {
      return { 
        success: false, 
        deltaBalance: 0, 
        gasCostUsd: 0, 
        swapCostUsd: 0, 
        callerIncentiveUsd: 0,
        netProfitUsd: 0, 
        error: 'Function not found' 
      };
    }

    let callData: string;
    try {
      // Try with no args first
      callData = iface.encodeFunctionData(fn.name, []);
    } catch {
      try {
        // Try with executor address
        callData = iface.encodeFunctionData(fn.name, [executorAddress]);
      } catch {
        return { 
          success: false, 
          deltaBalance: 0, 
          gasCostUsd: 0, 
          swapCostUsd: 0, 
          callerIncentiveUsd: 0,
          netProfitUsd: 0, 
          error: 'Cannot encode function' 
        };
      }
    }

    // Estimate gas with a safe buffer
    let gasEstimate: ethers.BigNumber;
    try {
      gasEstimate = await provider.estimateGas({
        to: protocol.address,
        data: callData,
        from: executorAddress,
      });
      // Add 20% buffer
      gasEstimate = gasEstimate.mul(120).div(100);
    } catch {
      // Fallback: use a reasonable gas limit
      gasEstimate = ethers.BigNumber.from(200000);
    }

    const gasCostNative = Number(ethers.utils.formatEther(gasPrice.mul(gasEstimate)));
    const gasCostUsd = gasCostNative * nativePriceUsd;

    // 3. Simulate swap: reward → entry token
    const amountIn = rewardAmount.toString();
    const quote = await getEnsoRouteQuote(rewardToken, protocol.entryToken, amountIn);

    if (!quote) {
      return { 
        success: false, 
        deltaBalance: 0, 
        gasCostUsd, 
        swapCostUsd: 0, 
        callerIncentiveUsd: 0,
        netProfitUsd: 0, 
        error: 'Failed to get swap quote' 
      };
    }

    // Calculate swap cost (slippage + protocol fee)
    const swapCostBps = 10; // 0.1% estimated
    const swapCostUsd = rewardUsd * (swapCostBps / 10000);

    // 4. Calculate caller incentive (if applicable)
    let callerIncentiveUsd = rewardUsd;
    if (protocol.callerIncentiveBps) {
      // For Beefy-style: caller gets a percentage of performance fee
      callerIncentiveUsd = rewardUsd * (protocol.callerIncentiveBps / 10000);
    }

    // 5. Flashloan fee (0% with Morpho, 0.09% with Aave)
    const flashloanFeeUsd = 0; // Using Morpho for 0% fee

    // 6. Net profit
    const netProfitUsd = callerIncentiveUsd - gasCostUsd - swapCostUsd - flashloanFeeUsd;

    log.debug(`Simulation result for ${protocol.id}.${functionName}`, {
      rewardUsd,
      callerIncentiveUsd,
      gasCostUsd,
      swapCostUsd,
      flashloanFeeUsd,
      netProfitUsd,
    });

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

  // 1. Discover all harvestable protocols
  const protocols = await discoverProtocols();

  if (protocols.length === 0) {
    log.warn('⚠️ No harvestable protocols discovered — check configuration');
    return [];
  }

  // Sort by priority (Priority 1 first)
  const sortedProtocols = [...protocols].sort((a, b) => a.priority - b.priority);

  log.info(`📋 Scanning ${sortedProtocols.length} harvestable protocols`);

  // 2. For each protocol, check pending rewards
  for (const protocol of sortedProtocols) {
    try {
      log.debug(`Checking protocol: ${protocol.id} (${protocol.name})`);

      // Skip if address is invalid
      if (!ethers.utils.isAddress(protocol.address) || protocol.address === ethers.constants.AddressZero) {
        log.debug(`Skipping ${protocol.id}: invalid address`);
        continue;
      }

      // Check pending rewards
      const rewardCheck = await checkPendingRewards(protocol, executorAddress);

      if (!rewardCheck.hasRewards || rewardCheck.rewardAmount.lte(0)) {
        log.debug(`No rewards for ${protocol.id}`);
        continue;
      }

      log.info(`Found rewards for ${protocol.id}`, {
        rewardAmount: ethers.utils.formatUnits(rewardCheck.rewardAmount, rewardCheck.rewardToken.decimals),
        rewardToken: rewardCheck.rewardToken.symbol,
      });

      // 3. Try each harvest-like function
      for (const fn of protocol.functions) {
        if (!isHarvestLikeFunction(fn.name)) continue;

        // 4. Simulate execution
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

        // Check minimum profit threshold
        const minProfit = env.CLASSIC_INCENTIVE_MIN_PROFIT_USD || env.DEFAULT_MIN_PROFIT_USD || 0.05;
        if (simulation.netProfitUsd < minProfit) {
          log.debug(`Net profit ${simulation.netProfitUsd.toFixed(4)} below threshold ${minProfit}`);
          continue;
        }

        // 5. Create candidate
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
          gasCostUsd: simulation.gasCostUsd.toFixed(4),
          swapCostUsd: simulation.swapCostUsd.toFixed(4),
        });

        // Only take the first successful function for this protocol
        break;
      }
    } catch (err) {
      log.debug(`Protocol check failed for ${protocol.id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (candidates.length === 0) {
    log.info('📭 Classic Incentive found 0 harvest opportunities this cycle');
  } else {
    log.info(`📦 Classic Incentive found ${candidates.length} harvest opportunities`);
  }

  return candidates;
}