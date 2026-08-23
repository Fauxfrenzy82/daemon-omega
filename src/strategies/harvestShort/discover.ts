import { ethers } from 'ethers';
import { TokenInfo } from '../../config/tokens';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';
import { getDirectDexQuote } from '../../scanner/sources/directDexSource';
import { REWARD_POSITIONS } from '../../config/farms';
import { getLiveTokenPriceUsd } from '../../utils/priceUtils';

const log = createLogger('harvestShort');

export async function discoverHarvestShort(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  log.info('🔍 Harvest + Spot Sell discovery started');

  if (REWARD_POSITIONS.length === 0) {
    log.info('📭 Harvest + Spot Sell: No reward positions configured. Add farms to src/config/farms.ts');
    return [];
  }

  for (const position of REWARD_POSITIONS) {
    try {
      // For v1, we assume rewards are claimable.
      // In production, call the contract's pendingRewards function.
      // Here we use a fixed amount for demo (1 token).
      const rewardAmount = ethers.utils.parseUnits('1', position.rewardToken.decimals);

      // Check liquidity for reward token -> entry token
      const sellQuote = await getDirectDexQuote(
        'uniswap-v3',
        position.rewardToken,
        position.entryToken,
        rewardAmount.toString()
      );

      if (!sellQuote) {
        log.debug(`No liquidity for ${position.rewardToken.symbol} -> ${position.entryToken.symbol}`);
        continue;
      }

      const rewardPrice = await getLiveTokenPriceUsd(position.rewardToken);
      const rewardValue = (Number(rewardAmount) / 10 ** position.rewardToken.decimals) * rewardPrice;
      const estimatedGasUsd = 0.05 * nativePriceUsd;
      const netProfitUsd = rewardValue - estimatedGasUsd;

      if (netProfitUsd > env.DEFAULT_MIN_PROFIT_USD) {
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
            rewardValue,
            nativePriceUsd,
          },
          estimatedGrossProfitUsd: rewardValue,
          estimatedNetProfitUsd: netProfitUsd,
          estimatedCostUsd: rewardValue - netProfitUsd,
          actionPlan: null,
          sourceTimestamp: Date.now(),
        };

        candidates.push(candidate);
        log.info(`Found harvest opportunity for ${position.id}`, {
          rewardValue: rewardValue.toFixed(4),
          netProfitUsd: netProfitUsd.toFixed(4),
        });
      } else {
        log.debug(`Harvest opportunity below threshold for ${position.id}`, {
          rewardValue,
          netProfitUsd: netProfitUsd.toFixed(6),
          threshold: env.DEFAULT_MIN_PROFIT_USD
        });
      }
    } catch (err) {
      log.debug(`Harvest check failed for ${position.id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info(`Harvest + Spot Sell found ${candidates.length} candidates`);
  return candidates;
}