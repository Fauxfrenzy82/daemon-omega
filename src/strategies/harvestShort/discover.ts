import { ethers } from 'ethers';
import { TokenInfo } from '../../config/tokens';
import { OpportunityCandidate } from '../common/opportunityCandidate';
import { createLogger } from '../../utils/logger';
import { env } from '../../config/env';
import { getDirectDexQuote } from '../../scanner/sources/directDexSource';
import { TOKENS } from '../../config/tokens';

const log = createLogger('harvestShort');

// Known reward-bearing positions (v1: QuickSwap farms, etc.)
// In production, this would be discovered via subgraph or on-chain.
// For now we use a placeholder; these addresses need to be verified.
const REWARD_POSITIONS: Array<{
  id: string;
  positionAddress: string;
  rewardToken: TokenInfo;
  entryToken: TokenInfo;
  protocol: string;
}> = [
  // Example: QuickSwap QUICK-USDC farm (fictional address for demo)
  // {
  //   id: 'quickswap-quick-usdc',
  //   positionAddress: '0x...',
  //   rewardToken: TOKENS.QUICK,
  //   entryToken: TOKENS.USDC,
  //   protocol: 'quickswap',
  // },
];

function getTokenPriceUsd(token: TokenInfo): number {
  if (['USDC', 'USDC.e', 'USDT', 'DAI'].includes(token.symbol)) {
    return 1.0;
  }
  const priceMap: Record<string, number> = {
    'WMATIC': 0.5,
    'WETH': 3000,
    'WBTC': 60000,
    'QUICK': 0.05,
    'GHST': 1.5,
  };
  return priceMap[token.symbol] || 0.01;
}

export async function discoverHarvestShort(nativePriceUsd: number): Promise<OpportunityCandidate[]> {
  const candidates: OpportunityCandidate[] = [];

  if (REWARD_POSITIONS.length === 0) {
    log.debug('No reward positions configured, skipping harvest discovery');
    return [];
  }

  for (const position of REWARD_POSITIONS) {
    try {
      // For v1, we assume rewards are claimable.
      // In production, call the contract's pendingRewards function.
      // Here we use a fixed amount for demo.
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

      const rewardValue = (Number(rewardAmount) / 10 ** position.rewardToken.decimals) *
        getTokenPriceUsd(position.rewardToken);
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