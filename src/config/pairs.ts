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

// Increased maxPositionUsd to match MAX_POSITION_SIZE_USD=1000
export const PAIRS: PairConfig[] = [
  {
    id: 'WETH-USDC',
    base: getToken('WETH'),
    quote: getToken('USDC'),
    minProfitUsd: 0.5,
    minSpreadBps: 5,
    maxPositionUsd: 100,
    enabled: true,
  },
  {
    id: 'WBTC-USDC',
    base: getToken('WBTC'),
    quote: getToken('USDC'),
    minProfitUsd: 0.5,
    minSpreadBps: 5,
    maxPositionUsd: 1000,
    enabled: true,
  },
  {
    id: 'WMATIC-USDC',
    base: getToken('WMATIC'),
    quote: getToken('USDC'),
    minProfitUsd: 0.2,
    minSpreadBps: 5,
    maxPositionUsd: 500,
    enabled: true,
  },
  {
    id: 'USDCe-USDT',
    base: getToken('USDCe'),
    quote: getToken('USDT'),
    minProfitUsd: 0.1,
    minSpreadBps: 3,
    maxPositionUsd: 500,
    enabled: true,
  },
  {
    id: 'DAI-USDC',
    base: getToken('DAI'),
    quote: getToken('USDC'),
    minProfitUsd: 0.1,
    minSpreadBps: 3,
    maxPositionUsd: 500,
    enabled: true,
  },
];

export function enabledPairs(): PairConfig[] {
  return PAIRS.filter((p) => p.enabled);
}