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
 * 
 * QuickSwap Eternal Farming: 0x8a26436e41d0b5fc4c6ed36c1976fafbe173444e[reference:10][reference:11]
 * Farming Center: 0x7F281A8cdF66eF5e9db8434Ec6D97acc1bc01E78[reference:12]
 * 
 * To discover more farms, query the QuickSwap V3 subgraph:
 * https://api.thegraph.com/subgraphs/name/sameepsi/quickswap-v3[reference:13]
 */
export const REWARD_POSITIONS: RewardPosition[] = [
  {
    id: 'quickswap-eternal-quick-usdc',
    positionAddress: '0x8a26436e41d0b5fc4c6ed36c1976fafbe173444e',
    rewardToken: TOKENS.QUICK,
    entryToken: TOKENS.USDC,
    protocol: 'quickswap',
  },
  // Add more farms as they are discovered/verified:
  // {
  //   id: 'quickswap-farm-wmatic-usdc',
  //   positionAddress: '0x...',
  //   rewardToken: TOKENS.WMATIC,
  //   entryToken: TOKENS.USDC,
  //   protocol: 'quickswap',
  // },
];