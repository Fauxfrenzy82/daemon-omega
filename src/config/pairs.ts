import { getToken, TokenInfo } from './tokens';
import { env } from './env';

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
    minProfitUsd: env.DEFAULT_MIN_PROFIT_USD,
    minSpreadBps: env.DEFAULT_MIN_SPREAD_BPS,
    maxPositionUsd: env.MAX_POSITION_SIZE_USD,
    enabled: true,
  },
  {
    id: 'WBTC-USDC',
    base: getToken('WBTC'),   // ✅ Correct – deployed version must have this
    quote: getToken('USDC'),
    minProfitUsd: env.DEFAULT_MIN_PROFIT_USD,
    minSpreadBps: env.DEFAULT_MIN_SPREAD_BPS,
    maxPositionUsd: env.MAX_POSITION_SIZE_USD,
    enabled: true,
  },
  {
    id: 'WMATIC-USDC',
    base: getToken('WMATIC'),
    quote: getToken('USDC'),
    minProfitUsd: env.DEFAULT_MIN_PROFIT_USD,
    minSpreadBps: env.DEFAULT_MIN_SPREAD_BPS,
    maxPositionUsd: env.MAX_POSITION_SIZE_USD,
    enabled: false,
  },
  {
    id: 'USDCe-USDT',
    base: getToken('USDCe'),
    quote: getToken('USDT'),
    minProfitUsd: env.DEFAULT_MIN_PROFIT_USD,
    minSpreadBps: env.DEFAULT_MIN_SPREAD_BPS,
    maxPositionUsd: env.MAX_POSITION_SIZE_USD,
    enabled: false,
  },
  {
    id: 'DAI-USDC',
    base: getToken('DAI'),
    quote: getToken('USDC'),
    minProfitUsd: env.DEFAULT_MIN_PROFIT_USD,
    minSpreadBps: env.DEFAULT_MIN_SPREAD_BPS,
    maxPositionUsd: env.MAX_POSITION_SIZE_USD,
    enabled: false,
  },
];

export function enabledPairs(): PairConfig[] {
  return PAIRS.filter((p) => p.enabled);
}