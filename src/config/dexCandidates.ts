import { TokenInfo } from './tokens';

export interface DexCandidate {
  id: string;                    // unique label
  protocol: string;              // Enso protocol slug (e.g., 'uniswap-v3')
  primaryAddress: string;        // router contract address
  extraArgs?: Record<string, string>; // e.g., { poolFee: '3000' }
  // Optional: you can also include a function to get poolId if needed
}

/**
 * Verified DEX routers on Polygon, with correct poolFee values.
 */
export const DEX_CANDIDATES: DexCandidate[] = [
  {
    id: 'uniswap-v3',
    protocol: 'uniswap-v3',
    primaryAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    extraArgs: { poolFee: '3000' }, // 0.3% fee tier for WETH/USDC
  },
  {
    id: 'sushiswap-v2',
    protocol: 'sushiswap-v2',
    primaryAddress: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
  },
  {
    id: 'sushiswap-v3',
    protocol: 'sushiswap-v3',
    primaryAddress: '0x00f23572b16c5e9e58e7b965def51ff8ff546e34',
    extraArgs: { poolFee: '3000' },
  },
  {
    id: 'quickswap-v2',
    protocol: 'uniswap-v2', // QuickSwap is a Uniswap V2 fork
    primaryAddress: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
  },
  // Balancer V2 is skipped because it requires a `poolId` — you can add later.
  // Ramses V3 address is unverified — skip for now.
];