export interface DexCandidate {
  id: string;
  protocol: string;
  primaryAddress: string;
}

/**
 * Verified DEX routers on Polygon.
 */
export const DEX_CANDIDATES: DexCandidate[] = [
  {
    id: 'uniswap-v3',
    protocol: 'uniswap-v3',
    primaryAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
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
  },
  {
    id: 'quickswap-v2',
    protocol: 'uniswap-v2',
    primaryAddress: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
  },
];