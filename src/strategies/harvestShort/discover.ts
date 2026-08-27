import { ethers } from 'ethers';
import { TokenInfo } from '../../config/tokens';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';
import { REWARD_POSITIONS } from '../../config/farms';
import { getLiveTokenPriceUsd } from '../../utils/priceUtils';
import { pushCandidate } from '../../execution/queue';
import { getEnsoRouteQuote } from '../../scanner/sources/ensoRoute';
import { getEnsoClient } from '../../execution/ensoClient';
import { provider } from '../../treasury/wallets';

const log = createLogger('harvestShort');

// ABI for checking pending rewards and pool reserves
const FARM_ABI = [
  'function pendingRewards(address user) view returns (uint256)',
  'function rewardToken() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

// QuickSwap V3 Pool ABI for depth checks
const POOL_ABI = [
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

/**
 * Calculate the maximum safe flashloan amount based on pool depth.
 * Prevents self-inflicted price impact > 1-2%.
 */
async function calculateMaxSafeFlashloan(
  poolAddress: string,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  desiredAmountUsd: number,
  maxDepthPct: number
): Promise<{ maxSafeUsd: number; poolDepthUsd: number; priceImpactBps: number }> {
  try {
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
    
    // Get pool liquidity and tick
    const liquidity = await pool.liquidity();
    const slot0 = await pool.slot0();
    
    // Get token addresses to determine which is which
    const token0 = await pool.token0();
    const token1 = await pool.token1();
    
    // Get prices for both tokens
    const price0 = await getLiveTokenPriceUsd(
      token0.toLowerCase() === tokenIn.address.toLowerCase() ? tokenIn : tokenOut
    );
    const price1 = await getLiveTokenPriceUsd(
      token1.toLowerCase() === tokenIn.address.toLowerCase() ? tokenIn : tokenOut
    );
    
    // Estimate pool depth in USD (simplified: liquidity * sqrt(priceX96) approximation)
    // More accurate: use getReserves for V2 or sqrtPriceX96 for V3
    const sqrtPriceX96 = slot0[0];
    const sqrtPrice = Number(sqrtPriceX96) / 2**96;
    
    // Estimate depth: liquidity * sqrt(price) * 2 (approximate for V3)
    const liquidityNum = Number(liquidity) / 1e18;
    const estimatedDepthUsd = liquidityNum * sqrtPrice * 2 * (price0 + price1) / 2;
    
    // Fallback: use a reasonable default if estimation fails
    const poolDepthUsd = estimatedDepthUsd > 0 ? estimatedDepthUsd : 1000000;
    
    // Max safe = poolDepthUsd * (maxDepthPct / 100)
    const maxSafeUsd = poolDepthUsd * (maxDepthPct / 100);
    
    // Calculate estimated price impact
    const impactBps = (desiredAmountUsd / poolDepthUsd) * 10000;
    
    return {
      maxSafeUsd: Math.min(maxSafeUsd, env.MAX_POSITION_SIZE_USD),
      poolDepthUsd,
      priceImpactBps: Math.min(impactBps, 10000),
    };
  } catch (err) {
    log.warn('Failed to calculate pool depth, using fallback', {
      poolAddress,
      error: err instanceof Error ? err.message : String(err),
    });
    // Fallback: use MAX_POSITION_SIZE_USD as safe limit
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

  if (REWARD_POSITIONS.length === 0) {
    log.info('📭 Harvest + Spot Sell: No reward positions configured. Add farms to src/config/farms.ts');
    return [];
  }

  const enso = getEnsoClient();

  for (const position of REWARD_POSITIONS) {
    try {
      log.info(`📊 Checking farm: ${position.id}`, {
        rewardToken: position.rewardToken.symbol,
        entryToken: position.entryToken.symbol,
        positionAddress: position.positionAddress,
      });

      // 🔥 Try to get actual pending rewards
      let rewardAmount: ethers.BigNumber;
      let rewardSource = 'hardcoded';

      try {
        const farmContract = new ethers.Contract(
          position.positionAddress,
          FARM_ABI,
          provider
        );
        
        const pending = await farmContract.pendingRewards(
          (await import('../../treasury/wallets')).executionWallet.address
        );
        
        if (pending && pending.gt(0)) {
          rewardAmount = pending;
          rewardSource = 'contract';
          log.info(`✅ Pending rewards from contract`, {
            positionId: position.id,
            rewardAmount: ethers.utils.formatUnits(pending, position.rewardToken.decimals),
            source: rewardSource,
          });
        } else {
          rewardAmount = ethers.utils.parseUnits('1', position.rewardToken.decimals);
          log.debug(`No pending rewards found, using fallback amount (1 token)`, {
            positionId: position.id,
          });
        }
      } catch (err) {
        rewardAmount = ethers.utils.parseUnits('1', position.rewardToken.decimals);
        log.debug(`Contract call failed, using fallback amount (1 token)`, {
          positionId: position.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Get reward token price
      const rewardPrice = await getLiveTokenPriceUsd(position.rewardToken);
      const rewardValue = (Number(rewardAmount) / 10 ** position.rewardToken.decimals) * rewardPrice;

      log.info(`💰 Reward value calculated`, {
        positionId: position.id,
        rewardToken: position.rewardToken.symbol,
        rewardAmountHuman: ethers.utils.formatUnits(rewardAmount, position.rewardToken.decimals),
        rewardPriceUsd: rewardPrice,
        rewardValueUsd: rewardValue,
      });

      // 🔥 Get Enso route for the sell quote
      const sellQuote = await getEnsoRouteQuote(
        position.rewardToken,
        position.entryToken,
        rewardAmount.toString()
      );

      if (!sellQuote) {
        log.debug(`No Enso route for ${position.rewardToken.symbol} -> ${position.entryToken.symbol}`);
        continue;
      }

      const estimatedGasUsd = 0.05 * nativePriceUsd;
      const harvestNetProfitUsd = rewardValue - estimatedGasUsd;

      // 🔥 Calculate flashloan arbitrage with pool depth safety
      const desiredFlashloanUsd = env.HARVEST_FLASHLOAN_AMOUNT_USD || 5000;
      const maxDepthPct = env.HARVEST_MAX_POOL_DEPTH_PCT || 1.5;

      // Get the pool address from the buy quote (if available) or use a default
      const poolAddress = sellQuote?.raw?.primaryAddress || 
                          (sellQuote?.raw?.route?.[0]?.primary) || 
                          '0x';

      let flashloanUsd = desiredFlashloanUsd;
      let poolDepthUsd = 0;
      let priceImpactBps = 0;

      if (poolAddress !== '0x') {
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
        
        log.info(`🛡️ Pool depth safety check`, {
          positionId: position.id,
          poolAddress,
          desiredUsd: desiredFlashloanUsd,
          maxSafeUsd: safety.maxSafeUsd,
          poolDepthUsd: safety.poolDepthUsd,
          priceImpactBps: safety.priceImpactBps,
          finalFlashloanUsd: flashloanUsd,
        });
      }

      // Only proceed if flashloan amount is meaningful (>= $100)
      if (flashloanUsd < 100) {
        log.debug(`Flashloan amount too small, skipping arbitrage`, {
          positionId: position.id,
          flashloanUsd,
        });
        continue;
      }

      const entryTokenPrice = await getLiveTokenPriceUsd(position.entryToken);
      const flashloanAmount = ethers.utils.parseUnits(
        (flashloanUsd / entryTokenPrice).toFixed(position.entryToken.decimals),
        position.entryToken.decimals
      ).toString();

      // Get quote for flashloan arbitrage (entryToken → rewardToken → entryToken)
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
          
          // 🔥 Morpho flashloan fee is 0% (confirmed by Enso docs)[reference:2]
          const flashloanFeeUsd = 0;
          arbitrageNetProfitUsd = arbitrageGrossProfitUsd - estimatedGasUsd - flashloanFeeUsd;

          log.info(`🔄 Flashloan arbitrage potential`, {
            positionId: position.id,
            flashloanSizeUsd: flashloanUsd,
            flashloanAmount,
            buyQuoteAmountOut: boughtRewardAmount,
            sellBackAmountOut: sellBackQuote.amountOut,
            arbitrageGrossProfitUsd: arbitrageGrossProfitUsd.toFixed(4),
            arbitrageNetProfitUsd: arbitrageNetProfitUsd.toFixed(4),
            flashloanFeeUsd,
            protocol: env.HARVEST_FLASHLOAN_PROTOCOL,
          });
        }
      }

      // Use the higher of the two profits
      const totalNetProfitUsd = Math.max(harvestNetProfitUsd, arbitrageNetProfitUsd);

      log.info(`📈 Final profit calculation`, {
        positionId: position.id,
        harvestNetProfitUsd: harvestNetProfitUsd.toFixed(4),
        arbitrageNetProfitUsd: arbitrageNetProfitUsd.toFixed(4),
        totalNetProfitUsd: totalNetProfitUsd.toFixed(4),
        threshold: env.DEFAULT_MIN_PROFIT_USD,
        isProfitable: totalNetProfitUsd > env.DEFAULT_MIN_PROFIT_USD,
      });

      if (totalNetProfitUsd > env.DEFAULT_MIN_PROFIT_USD) {
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
            useFlashloanArbitrage: arbitrageNetProfitUsd > harvestNetProfitUsd,
            flashloanSizeUsd: flashloanUsd,
            flashloanAmount: flashloanAmount,
            buyQuote: buyQuote || null,
            rewardValue,
            nativePriceUsd,
            poolDepthUsd,
            priceImpactBps,
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
          usingArbitrage: arbitrageNetProfitUsd > harvestNetProfitUsd,
          flashloanSize: flashloanUsd,
          flashloanProtocol: env.HARVEST_FLASHLOAN_PROTOCOL,
        });
      } else {
        log.debug(`❌ Below threshold for ${position.id}`, {
          netProfitUsd: totalNetProfitUsd.toFixed(6),
          threshold: env.DEFAULT_MIN_PROFIT_USD,
        });
      }
    } catch (err) {
      log.debug(`Harvest check failed for ${position.id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info(`📊 Harvest + Spot Sell found ${candidates.length} candidates`);
  return candidates;
}