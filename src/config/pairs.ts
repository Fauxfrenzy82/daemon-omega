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

// All pairs use the SAME thresholds from environment variables.
// This makes tuning easy — change MIN_PROFIT_USD and MIN_SPREAD_BPS in Render.
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
    base: getToken('WBTC'),
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
    enabled: true,
  },
  {
    id: 'USDCe-USDT',
    base: getToken('USDCe'),
    quote: getToken('USDT'),
    minProfitUsd: env.DEFAULT_MIN_PROFIT_USD,
    minSpreadBps: env.DEFAULT_MIN_SPREAD_BPS,
    maxPositionUsd: env.MAX_POSITION_SIZE_USD,
    enabled: true,
  },
  {
    id: 'DAI-USDC',
    base: getToken('DAI'),
    quote: getToken('USDC'),
    minProfitUsd: env.DEFAULT_MIN_PROFIT_USD,
    minSpreadBps: env.DEFAULT_MIN_SPREAD_BPS,
    maxPositionUsd: env.MAX_POSITION_SIZE_USD,
    enabled: true,
  },
];

export function enabledPairs(): PairConfig[] {
  return PAIRS.filter((p) => p.enabled);
}