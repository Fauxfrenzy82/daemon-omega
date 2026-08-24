import { ethers } from 'ethers';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';
import { pushCandidate } from '../../execution/queue';
import { getEnsoRouteQuote } from '../../scanner/sources/ensoRoute';
import { getLiveTokenPriceUsd } from '../../utils/priceUtils';
import { TOKENS } from '../../config/tokens';

const log = createLogger('classicIncentive');

/**
 * Classic Incentive strategy finds one-time incentive programs
 * where entering/exiting a position yields an immediately claimable reward.
 * 
 * For v1, we use a pre-configured list of known incentive programs.
 * In production, this would be dynamically discovered via on-chain queries.
 */
// Known incentive programs (placeholder – you'll need to populate this)
const INCENTIVE_PROGRAMS: Array<{
  id: string;
  positionAddress: string;
  rewardToken: TokenInfo;
  entryToken: TokenInfo;
  protocol: string;
  estimatedRewardAmount: string; // raw amount in smallest unit
}> = [
  // Example: QuickSwap incentive program
  // {
  //   id: 'quickswap-incentive-quick-usdc',
  //   positionAddress: '0x...',
  //   rewardToken: TOKENS.QUICK,
  //   entryToken: TOKENS.USDC,
  //   protocol: 'quickswap',
  //   estimatedRewardAmount: ethers.utils.parseUnits('0.1', TOKENS.QUICK.decimals).toString(),
  // },
];

export async function discoverClassicIncentive(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  log.info('🔍 Classic Incentive discovery started');

  if (INCENTIVE_PROGRAMS.length === 0) {
    log.info('📭 Classic Incentive: No incentive programs configured. Add programs to src/strategies/classicIncentive/discover.ts');
    return [];
  }

  for (const program of INCENTIVE_PROGRAMS) {
    try {
      // Get quote for selling reward token using Enso route
      const sellQuote = await getEnsoRouteQuote(
        program.rewardToken,
        program.entryToken,
        program.estimatedRewardAmount
      );

      if (!sellQuote) {
        log.debug(`No Enso route for ${program.rewardToken.symbol} -> ${program.entryToken.symbol}`);
        continue;
      }

      const rewardPrice = await getLiveTokenPriceUsd(program.rewardToken);
      const rewardValue = (Number(program.estimatedRewardAmount) / 10 ** program.rewardToken.decimals) * rewardPrice;
      const estimatedGasUsd = 0.1 * nativePriceUsd;
      const netProfitUsd = rewardValue - estimatedGasUsd;

      if (netProfitUsd > env.DEFAULT_MIN_PROFIT_USD) {
        const candidate: OpportunityCandidate = {
          id: `incentive-${program.id}-${Date.now()}`,
          strategy: 'classicIncentive',
          protocol: program.protocol,
          params: {
            positionAddress: program.positionAddress,
            rewardToken: program.rewardToken,
            entryToken: program.entryToken,
            rewardAmount: program.estimatedRewardAmount,
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

        // STREAM: push immediately
        pushCandidate(candidate);
        candidates.push(candidate);
        log.info(`Found classic incentive candidate for ${program.id}`, {
          rewardValue: rewardValue.toFixed(4),
          netProfitUsd: netProfitUsd.toFixed(4),
        });
      } else {
        log.debug(`Incentive program ${program.id} below threshold`, {
          rewardValue,
          netProfitUsd: netProfitUsd.toFixed(6),
          threshold: env.DEFAULT_MIN_PROFIT_USD
        });
      }
    } catch (err) {
      log.debug(`Incentive check failed for ${program.id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info(`Classic Incentive found ${candidates.length} candidates`);
  return candidates;
}