export const PAIRS: PairConfig[] = [
  {
    id: 'WETH-USDC',
    base: getToken('WETH'),
    quote: getToken('USDC'),
    minProfitUsd: 0.5,
    minSpreadBps: 5,
    maxPositionUsd: 1000,   // ← changed from 100
    enabled: true,
  },
  {
    id: 'WBTC-USDC',
    base: getToken('WBTC'),
    quote: getToken('USDC'),
    minProfitUsd: 0.5,
    minSpreadBps: 5,
    maxPositionUsd: 1000,   // ← changed from 100
    enabled: true,
  },
  {
    id: 'WMATIC-USDC',
    base: getToken('WMATIC'),
    quote: getToken('USDC'),
    minProfitUsd: 0.2,
    minSpreadBps: 5,
    maxPositionUsd: 500,    // ← changed from 50
    enabled: true,
  },
  {
    id: 'USDCe-USDT',
    base: getToken('USDCe'),
    quote: getToken('USDT'),
    minProfitUsd: 0.1,
    minSpreadBps: 3,
    maxPositionUsd: 500,    // ← changed from 50
    enabled: true,
  },
  {
    id: 'DAI-USDC',
    base: getToken('DAI'),
    quote: getToken('USDC'),
    minProfitUsd: 0.1,
    minSpreadBps: 3,
    maxPositionUsd: 500,    // ← changed from 50
    enabled: true,
  },
];