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

const log = createLogger('harvestShort');

// 🔥 Add this ABI for checking pending rewards
const FARM_ABI = [
  'function pendingRewards(address user) view returns (uint256)',
  'function rewardToken() view returns (address)',
];

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
          (await import('../../treasury/wallets')).provider
        );
        
        // Try to get pending rewards
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
          // Fallback to 1 token if no pending rewards
          rewardAmount = ethers.utils.parseUnits('1', position.rewardToken.decimals);
          log.debug(`No pending rewards found, using fallback amount (1 token)`, {
            positionId: position.id,
          });
        }
      } catch (err) {
        // Fallback if contract call fails
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

      // 🔥 Use Enso route for the sell quote
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
      const netProfitUsd = rewardValue - estimatedGasUsd;

      // 🔥 Also calculate potential flashloan arbitrage profit
      const flashloanSizeUsd = env.HARVEST_FLASHLOAN_AMOUNT_USD || 500;
      const entryTokenPrice = await getLiveTokenPriceUsd(position.entryToken);
      const flashloanAmount = ethers.utils.parseUnits(
        (flashloanSizeUsd / entryTokenPrice).toFixed(position.entryToken.decimals),
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
        // Calculate round-trip profit
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
          arbitrageNetProfitUsd = arbitrageGrossProfitUsd - estimatedGasUsd - (flashloanSizeUsd * 0.0009); // Aave flashloan fee

          log.info(`🔄 Flashloan arbitrage potential`, {
            positionId: position.id,
            flashloanSizeUsd,
            flashloanAmount,
            buyQuoteAmountOut: boughtRewardAmount,
            sellBackAmountOut: sellBackQuote.amountOut,
            arbitrageGrossProfitUsd: arbitrageGrossProfitUsd.toFixed(4),
            arbitrageNetProfitUsd: arbitrageNetProfitUsd.toFixed(4),
          });
        }
      }

      // Use the higher of the two profits
      const totalNetProfitUsd = Math.max(netProfitUsd, arbitrageNetProfitUsd);

      log.info(`📈 Final profit calculation`, {
        positionId: position.id,
        harvestNetProfitUsd: netProfitUsd.toFixed(4),
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
            // 🔥 Add flashloan arbitrage params
            useFlashloanArbitrage: arbitrageNetProfitUsd > netProfitUsd,
            flashloanSizeUsd: flashloanSizeUsd,
            flashloanAmount: flashloanAmount,
            buyQuote: buyQuote || null,
            rewardValue,
            nativePriceUsd,
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
          usingArbitrage: arbitrageNetProfitUsd > netProfitUsd,
          flashloanSize: flashloanSizeUsd,
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