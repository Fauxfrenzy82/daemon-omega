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
    minProfitUsd: 1.0,
    minSpreadBps: 10,
    maxPositionUsd: 100,
    enabled: true,
  },
  {
    id: 'WBTC-USDC',
    base: getToken('WBTC'),
    quote: getToken('USDC'),
    minProfitUsd: 1.0,
    minSpreadBps: 10,
    maxPositionUsd: 100,
    enabled: true,
  },
  {
    id: 'WMATIC-USDC',
    base: getToken('WMATIC'),
    quote: getToken('USDC'),
    minProfitUsd: 0.5,
    minSpreadBps: 10,
    maxPositionUsd: 100,
    enabled: true,
  },
  {
    id: 'USDCe-USDT',
    base: getToken('USDCe'),
    quote: getToken('USDT'),
    minProfitUsd: 0.5,
    minSpreadBps: 10,
    maxPositionUsd: 100,
    enabled: false,
  },
  {
    id: 'DAI-USDC',
    base: getToken('DAI'),
    quote: getToken('USDC'),
    minProfitUsd: 0.5,
    minSpreadBps: 10,
    maxPositionUsd: 100,
    enabled: false,
  },
];

export function enabledPairs(): PairConfig[] {
  return PAIRS.filter((p) => p.enabled);
}