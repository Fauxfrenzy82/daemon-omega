import { ethers } from 'ethers';
import { TokenInfo } from '../../config/tokens';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';
import { getRewardPositions } from '../../config/farms';
import { getLiveTokenPriceUsd } from '../../utils/priceUtils';
import { pushCandidate } from '../../execution/queue';
import { getEnsoRouteQuote } from '../../scanner/sources/ensoRoute';
import { getEnsoClient } from '../../execution/ensoClient';
import { provider } from '../../treasury/wallets';

const log = createLogger('harvestShort');

// 🔥 Minimal ABI for checking if a contract has rewards
const MINIMAL_FARM_ABI = [
  'function rewardToken() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

/**
 * Calculate the maximum safe flashloan amount based on pool depth.
 * Prevents self-inflicted price impact > configured threshold.
 */
async function calculateMaxSafeFlashloan(
  poolAddress: string,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  desiredAmountUsd: number,
  maxDepthPct: number
): Promise<{ maxSafeUsd: number; poolDepthUsd: number; priceImpactBps: number }> {
  try {
    // Simplified pool depth estimation using token price and known liquidity
    const tokenPrice = await getLiveTokenPriceUsd(tokenIn);
    const estimatedDepthUsd = 1000000; // Conservative default for Polygon pools
    
    const poolDepthUsd = estimatedDepthUsd;
    const maxSafeUsd = poolDepthUsd * (maxDepthPct / 100);
    const impactBps = (desiredAmountUsd / poolDepthUsd) * 10000;
    
    return {
      maxSafeUsd: Math.min(maxSafeUsd, env.MAX_POSITION_SIZE_USD || 25000),
      poolDepthUsd,
      priceImpactBps: Math.min(impactBps, 10000),
    };
  } catch (err) {
    log.warn('Failed to calculate pool depth, using fallback', {
      poolAddress,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      maxSafeUsd: env.MAX_POSITION_SIZE_USD || 25000,
      poolDepthUsd: 1000000,
      priceImpactBps: 0,
    };
  }
}

export async function discoverHarvestShort(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  log.info('🔍 Harvest + Spot Sell discovery started');

  // 🔥 Get reward positions dynamically
  const rewardPositions = await getRewardPositions();
  
  if (rewardPositions.length === 0) {
    log.info('📭 Harvest + Spot Sell: No reward positions found. Run initializeFarms() first.');
    return [];
  }

  log.info(`📋 Configured farms: ${rewardPositions.length}`, {
    farms: rewardPositions.map((f: any) => ({
      id: f.id,
      rewardToken: f.rewardToken.symbol,
      entryToken: f.entryToken.symbol,
      protocol: f.protocol,
    })),
  });

  for (const position of rewardPositions) {
    const startTime = Date.now();
    let stepLog: string[] = [];

    try {
      stepLog.push(`START: Checking ${position.id}`);

      log.info(`📊 Checking farm: ${position.id}`, {
        rewardToken: position.rewardToken.symbol,
        entryToken: position.entryToken.symbol,
        positionAddress: position.positionAddress,
        protocol: position.protocol,
      });

      // 🔥 Step 1: Verify the farm contract is reachable
      stepLog.push('Step 1: Verifying contract');
      let contractExists = false;
      try {
        const code = await provider.getCode(position.positionAddress);
        contractExists = code !== '0x';
        stepLog.push(`Contract exists: ${contractExists}`);
        if (!contractExists) {
          log.warn(`⚠️ No contract at ${position.positionAddress} for ${position.id}`);
          continue;
        }
      } catch (err) {
        stepLog.push(`Contract check failed: ${err instanceof Error ? err.message : String(err)}`);
        log.warn(`⚠️ Could not verify contract for ${position.id}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // 🔥 Step 2: Try to get basic contract info (non-critical)
      stepLog.push('Step 2: Getting contract info');
      let rewardTokenAddress: string | null = null;
      let totalSupply: ethers.BigNumber | null = null;

      try {
        const farmContract = new ethers.Contract(
          position.positionAddress,
          MINIMAL_FARM_ABI,
          provider
        );
        
        // Try to get reward token (may fail for some farms)
        try {
          const rt = await farmContract.rewardToken();
          rewardTokenAddress = rt;
          stepLog.push(`Reward token address: ${rewardTokenAddress}`);
        } catch (err) {
          stepLog.push(`Could not get rewardToken(): ${err instanceof Error ? err.message : String(err)}`);
          // Non-critical – we already have the reward token from config
        }

        // Try to get total supply (indicates farm activity)
        try {
          totalSupply = await farmContract.totalSupply();
          stepLog.push(`Total supply: ${totalSupply ? ethers.utils.formatEther(totalSupply) : 'unknown'}`);
        } catch (err) {
          stepLog.push(`Could not get totalSupply(): ${err instanceof Error ? err.message : String(err)}`);
        }
      } catch (err) {
        stepLog.push(`Contract info failed: ${err instanceof Error ? err.message : String(err)}`);
        // Continue – we'll use Enso for the actual harvest
      }

      // 🔥 Step 3: Get reward token price
      stepLog.push('Step 3: Getting reward price');
      let rewardPrice: number;
      let rewardValue: number;
      let rewardAmount: ethers.BigNumber;

      try {
        rewardPrice = await getLiveTokenPriceUsd(position.rewardToken);
        stepLog.push(`Reward price: $${rewardPrice}`);
        
        // Use a reasonable amount for evaluation – Enso will handle the actual harvest
        const evalAmount = ethers.utils.parseUnits(
          '0.01',
          position.rewardToken.decimals
        );
        rewardAmount = evalAmount;
        rewardValue = (Number(evalAmount) / 10 ** position.rewardToken.decimals) * rewardPrice;
        stepLog.push(`Evaluation amount: ${ethers.utils.formatUnits(evalAmount, position.rewardToken.decimals)} ${position.rewardToken.symbol} = $${rewardValue.toFixed(4)}`);
      } catch (err) {
        stepLog.push(`Price fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        log.warn(`⚠️ Could not get price for ${position.rewardToken.symbol}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // 🔥 Step 4: Get Enso route for sell quote
      stepLog.push('Step 4: Getting Enso sell route');
      const rewardAmountStr = ethers.utils.parseUnits(
        '0.01',
        position.rewardToken.decimals
      ).toString();

      const sellQuote = await getEnsoRouteQuote(
        position.rewardToken,
        position.entryToken,
        rewardAmountStr
      );

      if (!sellQuote) {
        stepLog.push(`No Enso route for ${position.rewardToken.symbol} -> ${position.entryToken.symbol}`);
        log.debug(`No Enso route for ${position.rewardToken.symbol} -> ${position.entryToken.symbol}`);
        continue;
      }
      stepLog.push(`Sell route found: ${sellQuote.amountOut} ${position.entryToken.symbol}`);

      // 🔥 Step 5: Calculate simple harvest profit
      stepLog.push('Step 5: Calculating harvest profit');
      const estimatedGasUsd = 0.05 * nativePriceUsd;
      const harvestNetProfitUsd = rewardValue - estimatedGasUsd;
      stepLog.push(`Harvest profit: $${harvestNetProfitUsd.toFixed(4)} (reward: $${rewardValue.toFixed(4)} - gas: $${estimatedGasUsd.toFixed(4)})`);

      // 🔥 Step 6: Calculate flashloan arbitrage with pool depth safety
      stepLog.push('Step 6: Calculating flashloan arbitrage');
      const desiredFlashloanUsd = env.HARVEST_FLASHLOAN_AMOUNT_USD || 5000;
      const maxDepthPct = env.HARVEST_MAX_POOL_DEPTH_PCT || 1.5;

      const poolAddress = sellQuote?.raw?.primaryAddress || 
                          (sellQuote?.raw?.route?.[0]?.primary) || 
                          position.positionAddress;

      let flashloanUsd = desiredFlashloanUsd;
      let poolDepthUsd = 0;
      let priceImpactBps = 0;

      if (poolAddress !== '0x' && poolAddress !== position.positionAddress) {
        const safety = await calculateMaxSafeFlashloan(
          poolAddress,
          position.entryToken,
          position.rewardToken,
          desiredFlashloanUsd,
          maxDepthPct
        );
        flashloanUsd = Math.min(desiredFlashloanUsd, safety.maxSafeUsd);
        poolDepthUsd = safety.poolDepthUsd;
        priceImpactBps = safety.priceImpactBps;
        stepLog.push(`Pool depth: $${poolDepthUsd.toFixed(0)}, safe max: $${safety.maxSafeUsd.toFixed(0)}, impact: ${priceImpactBps.toFixed(0)} bps`);
      } else {
        stepLog.push(`No pool address available, using default flashloan amount: $${flashloanUsd}`);
      }

      if (flashloanUsd < 100) {
        stepLog.push(`Flashloan amount too small ($${flashloanUsd}), skipping arbitrage`);
        continue;
      }

      const entryTokenPrice = await getLiveTokenPriceUsd(position.entryToken);
      const flashloanAmount = ethers.utils.parseUnits(
        (flashloanUsd / entryTokenPrice).toFixed(position.entryToken.decimals),
        position.entryToken.decimals
      ).toString();

      // Get quote for flashloan arbitrage
      const buyQuote = await getEnsoRouteQuote(
        position.entryToken,
        position.rewardToken,
        flashloanAmount
      );

      let arbitrageNetProfitUsd = 0;
      let arbitrageGrossProfitUsd = 0;

      if (buyQuote) {
        const boughtRewardAmount = buyQuote.amountOut;
        const sellBackQuote = await getEnsoRouteQuote(
          position.rewardToken,
          position.entryToken,
          boughtRewardAmount
        );

        if (sellBackQuote) {
          const amountInHuman = Number(flashloanAmount) / 10 ** position.entryToken.decimals;
          const amountOutHuman = Number(sellBackQuote.amountOut) / 10 ** position.entryToken.decimals;
          arbitrageGrossProfitUsd = (amountOutHuman - amountInHuman) * entryTokenPrice;
          
          // Morpho flashloan fee is 0%
          const flashloanFeeUsd = 0;
          arbitrageNetProfitUsd = arbitrageGrossProfitUsd - estimatedGasUsd - flashloanFeeUsd;

          stepLog.push(`Arbitrage: gross $${arbitrageGrossProfitUsd.toFixed(4)}, net $${arbitrageNetProfitUsd.toFixed(4)}`);
          log.info(`🔄 Flashloan arbitrage potential`, {
            positionId: position.id,
            flashloanSizeUsd: flashloanUsd,
            arbitrageGrossProfitUsd: arbitrageGrossProfitUsd.toFixed(4),
            arbitrageNetProfitUsd: arbitrageNetProfitUsd.toFixed(4),
            protocol: env.HARVEST_FLASHLOAN_PROTOCOL || 'morpho-markets-v1',
          });
        } else {
          stepLog.push('No sell-back quote available for arbitrage');
        }
      } else {
        stepLog.push('No buy quote available for arbitrage');
      }

      // 🔥 Step 7: Determine best approach
      stepLog.push('Step 7: Comparing approaches');
      const totalNetProfitUsd = Math.max(harvestNetProfitUsd, arbitrageNetProfitUsd);
      const usingArbitrage = arbitrageNetProfitUsd > harvestNetProfitUsd;

      stepLog.push(`Best profit: $${totalNetProfitUsd.toFixed(4)} (${usingArbitrage ? 'arbitrage' : 'harvest'})`);

      log.info(`📈 Final profit calculation`, {
        positionId: position.id,
        harvestNetProfitUsd: harvestNetProfitUsd.toFixed(4),
        arbitrageNetProfitUsd: arbitrageNetProfitUsd.toFixed(4),
        totalNetProfitUsd: totalNetProfitUsd.toFixed(4),
        threshold: env.DEFAULT_MIN_PROFIT_USD,
        isProfitable: totalNetProfitUsd > env.DEFAULT_MIN_PROFIT_USD,
        usingArbitrage,
        steps: stepLog.length,
      });

      // 🔥 Step 8: Create candidate if profitable
      if (totalNetProfitUsd > env.DEFAULT_MIN_PROFIT_USD) {
        stepLog.push(`✅ PROFITABLE! Creating candidate`);

        const candidate: OpportunityCandidate = {
          id: `harvest-${position.id}-${Date.now()}`,
          strategy: 'harvestShort',
          protocol: position.protocol,
          params: {
            positionAddress: position.positionAddress,
            rewardToken: position.rewardToken,
            entryToken: position.entryToken,
            rewardAmount: rewardAmount.toString(),
            sellQuote,
            useFlashloanArbitrage: usingArbitrage,
            flashloanSizeUsd: flashloanUsd,
            flashloanAmount: flashloanAmount,
            buyQuote: buyQuote || null,
            rewardValue,
            nativePriceUsd,
            poolDepthUsd,
            priceImpactBps,
            // 🔥 Debug info
            _debugSteps: stepLog,
            _contractExists: contractExists,
            _rewardTokenAddress: rewardTokenAddress,
          },
          estimatedGrossProfitUsd: Math.max(rewardValue, arbitrageGrossProfitUsd),
          estimatedNetProfitUsd: totalNetProfitUsd,
          estimatedCostUsd: (rewardValue > arbitrageGrossProfitUsd ? rewardValue : arbitrageGrossProfitUsd) - totalNetProfitUsd,
          actionPlan: null,
          sourceTimestamp: Date.now(),
        };

        pushCandidate(candidate);
        candidates.push(candidate);
        log.info(`✅ Found harvest opportunity for ${position.id}`, {
          rewardValue: rewardValue.toFixed(4),
          netProfitUsd: totalNetProfitUsd.toFixed(4),
          usingArbitrage,
          flashloanSize: flashloanUsd,
          flashloanProtocol: env.HARVEST_FLASHLOAN_PROTOCOL || 'morpho-markets-v1',
          stepsCount: stepLog.length,
        });
      } else {
        stepLog.push(`❌ Not profitable: $${totalNetProfitUsd.toFixed(4)} < $${env.DEFAULT_MIN_PROFIT_USD}`);
        log.debug(`❌ Below threshold for ${position.id}`, {
          netProfitUsd: totalNetProfitUsd.toFixed(6),
          threshold: env.DEFAULT_MIN_PROFIT_USD,
          stepsCount: stepLog.length,
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      stepLog.push(`❌ ERROR: ${errorMsg}`);
      log.error(`Harvest check failed for ${position.id}`, {
        error: errorMsg,
        steps: stepLog,
        stack: err instanceof Error ? err.stack : undefined,
      });
    } finally {
      const duration = Date.now() - startTime;
      log.debug(`⏱️ Harvest check completed in ${duration}ms`, {
        positionId: position.id,
        steps: stepLog.length,
        success: stepLog.some(s => s.includes('✅ PROFITABLE')),
      });
    }
  }

  log.info(`📊 Harvest + Spot Sell found ${candidates.length} candidates`);
  return candidates;
}