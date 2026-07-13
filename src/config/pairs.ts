import { getToken, TokenInfo } from './tokens';

export interface PairConfig {
  id: string;
  base: TokenInfo;
  quote: TokenInfo;
  minProfitUsd: number;
  minSpreadBps: number;
  maxPositionUsd: number;
  enabled: boolean;
}

export const PAIRS: PairConfig[] = [
  {
    id: 'WETH-USDC',
    base: getToken('WETH'),
    quote: getToken('USDC'),
    minProfitUsd: 0.5,
    minSpreadBps: 5,
    maxPositionUsd: 50,
    enabled: true,
  },
  // Disable others to isolate execution issues
  {
    id: 'WBTC-USDC',
    base: getToken('WBTC'),
    quote: getToken('USDC'),
    minProfitUsd: 1.0,
    minSpreadBps: 10,
    maxPositionUsd: 50,
    enabled: false,
  },
  {
    id: 'WMATIC-USDC',
    base: getToken('WMATIC'),
    quote: getToken('USDC'),
    minProfitUsd: 1.0,
    minSpreadBps: 10,
    maxPositionUsd: 50,
    enabled: false,
  },
  // Stable pairs disabled
];

export function enabledPairs(): PairConfig[] {
  return PAIRS.filter((p) => p.enabled);
}