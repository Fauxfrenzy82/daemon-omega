import { TokenInfo } from './tokens';
import { TOKENS } from './tokens';

export interface RewardPosition {
  id: string;
  positionAddress: string;
  rewardToken: TokenInfo;
  entryToken: TokenInfo;
  protocol: string;
}

/**
 * Real farm positions on Polygon.
 * For v1, we add known QuickSwap farms.
 * Add more as they are discovered/verified.
 */
export const REWARD_POSITIONS: RewardPosition[] = [
  {
    id: 'quickswap-quick-usdc',
    positionAddress: '0x8a26436e41d0b5fc4c6ed36c1976fafbe173444e', // QuickSwap perpetual farm
    rewardToken: TOKENS.QUICK,
    entryToken: TOKENS.USDC,
    protocol: 'quickswap',
  },
  // Add more farms below as they are verified
  // {
  //   id: 'sushiswap-x-usdc',
  //   positionAddress: '0x...',
  //   rewardToken: TOKENS.SUSHI,
  //   entryToken: TOKENS.USDC,
  //   protocol: 'sushiswap',
  // },
];