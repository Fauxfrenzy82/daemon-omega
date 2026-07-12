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

// Lower thresholds for testing — executable should become > 0.
export const PAIRS: PairConfig[] = [
  {
    id: 'WETH-USDC',
    base: getToken('WETH'),
    quote: getToken('USDC'),
    minProfitUsd: 0.5,      // lowered from 5
    minSpreadBps: 5,        // lowered from 25
    maxPositionUsd: 100,
    enabled: true,
  },
  {
    id: 'WBTC-USDC',
    base: getToken('WBTC'),
    quote: getToken('USDC'),
    minProfitUsd: 0.5,
    minSpreadBps: 5,
    maxPositionUsd: 100,
    enabled: true,
  },
  {
    id: 'WMATIC-USDC',
    base: getToken('WMATIC'),
    quote: getToken('USDC'),
    minProfitUsd: 0.2,
    minSpreadBps: 5,
    maxPositionUsd: 50,
    enabled: true,
  },
  {
    id: 'USDCe-USDT',
    base: getToken('USDCe'),
    quote: getToken('USDT'),
    minProfitUsd: 0.1,
    minSpreadBps: 3,
    maxPositionUsd: 50,
    enabled: true,
  },
  {
    id: 'DAI-USDC',
    base: getToken('DAI'),
    quote: getToken('USDC'),
    minProfitUsd: 0.1,
    minSpreadBps: 3,
    maxPositionUsd: 50,
    enabled: true,
  },
];

export function enabledPairs(): PairConfig[] {
  return PAIRS.filter((p) => p.enabled);
}