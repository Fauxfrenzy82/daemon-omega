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
  {
    id: 'LINK-USDC',
    base: getToken('LINK'),
    quote: getToken('USDC'),
    minProfitUsd: env.DEFAULT_MIN_PROFIT_USD,
    minSpreadBps: env.DEFAULT_MIN_SPREAD_BPS,
    maxPositionUsd: env.MAX_POSITION_SIZE_USD,
    enabled: true,
  },
  {
    id: 'AAVE-USDC',
    base: getToken('AAVE'),
    quote: getToken('USDC'),
    minProfitUsd: env.DEFAULT_MIN_PROFIT_USD,
    minSpreadBps: env.DEFAULT_MIN_SPREAD_BPS,
    maxPositionUsd: env.MAX_POSITION_SIZE_USD,
    enabled: true,
  },
  // New: thinner-liquidity pairs, deliberately smaller position size
  // ($50 vs the $500 used above) since these pools are expected to be
  // far shallower — this is the "test thinner pairs" experiment.
  {
    id: 'GHST-USDC',
    base: getToken('GHST'),
    quote: getToken('USDC'),
    minProfitUsd: env.DEFAULT_MIN_PROFIT_USD,
    minSpreadBps: env.DEFAULT_MIN_SPREAD_BPS,
    maxPositionUsd: 50,
    enabled: true,
  },
  {
    id: 'QUICK-USDC',
    base: getToken('QUICK'),
    quote: getToken('USDC'),
    minProfitUsd: env.DEFAULT_MIN_PROFIT_USD,
    minSpreadBps: env.DEFAULT_MIN_SPREAD_BPS,
    maxPositionUsd: 50,
    enabled: true,
  },
];

export function enabledPairs(): PairConfig[] {
  return PAIRS.filter((p) => p.enabled);
}