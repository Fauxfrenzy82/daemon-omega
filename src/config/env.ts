import dotenv from 'dotenv';

dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val || val.trim() === '') {
    throw new Error(`Missing required env var: ${key}`);
  }
  return val;
}

function optional(key: string, fallback: string): string {
  const val = process.env[key];
  return val && val.trim() !== '' ? val : fallback;
}

function optionalNumber(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val || val.trim() === '') return fallback;
  const n = Number(val);
  if (Number.isNaN(n)) throw new Error(`Env var ${key} must be a number`);
  return n;
}

function optionalBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (!val || val.trim() === '') return fallback;
  return val.toLowerCase() === 'true';
}

function normalizeEnsoBaseUrl(url: string): string {
  let normalized = url.replace(/\/+$/, '');
  if (!normalized.endsWith('/api')) {
    normalized = `${normalized}/api`;
  }
  return normalized;
}

export const env = {
  // Blockchain / RPC
  RPC_URL: required('RPC_URL'),
  RPC_WS_URL: optional('RPC_WS_URL', ''),
  CHAIN_ID: optionalNumber('CHAIN_ID', 137),

  // 🔥 NEW: Polygon Private Mempool RPC for transaction submission
  PRIVATE_MEMPOOL_RPC: optional('PRIVATE_MEMPOOL_RPC', 'https://private-mempool.polygon.technology'),

  // Private Mempool
  PRIVATE_MEMPOOL_URL: optional('PRIVATE_MEMPOOL_URL', 'https://private-mempool.polygon.technology'),

  // Wallets
  EXECUTION_PRIVATE_KEY: required('EXECUTION_PRIVATE_KEY'),
  TREASURY_ADDRESS: required('TREASURY_ADDRESS'),

  // --- Enso ---
  ENSO_API_KEY: required('ENSO_API_KEY'),
  ENSO_BASE_URL: normalizeEnsoBaseUrl(optional('ENSO_BASE_URL', 'https://api.enso.build/api')),

  // ParaSwap / OpenOcean
  PARASWAP_API_URL: optional('PARASWAP_API_URL', 'https://apiv5.paraswap.io'),
  OPENOCEAN_API_URL: optional('OPENOCEAN_API_URL', 'https://open-api.openocean.finance/v3/polygon'),
  ZEROEX_API_KEY: optional('ZEROEX_API_KEY', ''),

  // Database
  DATABASE_URL: required('DATABASE_URL'),

  // Risk / thresholds
  DEFAULT_MIN_PROFIT_USD: optionalNumber('MIN_PROFIT_USD', 0.05),
  DEFAULT_MIN_SPREAD_BPS: optionalNumber('MIN_SPREAD_BPS', 2),
  MAX_POSITION_SIZE_USD: optionalNumber('MAX_POSITION_SIZE_USD', 25000),
  MAX_CONCURRENT_TRADES: optionalNumber('MAX_CONCURRENT_TRADES', 3),
  MAX_SLIPPAGE_BPS: optionalNumber('MAX_SLIPPAGE_BPS', 300),
  MAX_PRICE_IMPACT_BPS: optionalNumber('MAX_PRICE_IMPACT_BPS', 300),

  // Circuit breaker
  MAX_CONSECUTIVE_LOSSES: optionalNumber('MAX_CONSECUTIVE_LOSSES', 999),
  CIRCUIT_BREAKER_LOOKBACK_MINUTES: optionalNumber('CIRCUIT_BREAKER_LOOKBACK_MINUTES', 5),
  MAX_GAS_PRICE_GWEI: optionalNumber('MAX_GAS_PRICE_GWEI', 300),
  CIRCUIT_BREAKER_COOLDOWN_MS: optionalNumber('CIRCUIT_BREAKER_COOLDOWN_MS', 15 * 60 * 1000),

  // Sweep
  SWEEP_ENABLED: optionalBool('SWEEP_ENABLED', true),
  SWEEP_MIN_BALANCE_USD: optionalNumber('SWEEP_MIN_BALANCE_USD', 2),
  SWEEP_KEEP_GAS_RESERVE_USD: optionalNumber('SWEEP_KEEP_GAS_RESERVE_USD', 1),
  SWEEP_TARGET_SYMBOL: optional('SWEEP_TARGET_SYMBOL', 'USDC'),
  SWEEP_DUST_THRESHOLD_USD: optionalNumber('SWEEP_DUST_THRESHOLD_USD', 0.01),

  // Alerts
  DISCORD_WEBHOOK_URL: optional('DISCORD_WEBHOOK_URL', ''),

  // Scanner
  SCAN_INTERVAL_MS: optionalNumber('SCAN_INTERVAL_MS', 15000),
  LOG_LEVEL: optional('LOG_LEVEL', 'info'),
  NODE_ENV: optional('NODE_ENV', 'production'),

  // Strategy toggles
  STRATEGY_LP_ENABLED: optionalBool('STRATEGY_LP_ENABLED', true),
  STRATEGY_VAULT_ENABLED: optionalBool('STRATEGY_VAULT_ENABLED', true),
  STRATEGY_DEBT_ENABLED: optionalBool('STRATEGY_DEBT_ENABLED', true),
  STRATEGY_HARVEST_ENABLED: optionalBool('STRATEGY_HARVEST_ENABLED', true),
  STRATEGY_CLASSIC_ENABLED: optionalBool('STRATEGY_CLASSIC_ENABLED', true),

  // Enso route
  USE_ENSO_ROUTE_PRIMARY: optionalBool('USE_ENSO_ROUTE_PRIMARY', true),
  ENSO_REQUEST_DELAY_MS: optionalNumber('ENSO_REQUEST_DELAY_MS', 800),
  PRIMARY_PAIR_IDS: optional('PRIMARY_PAIR_IDS', 'WETH-USDC,WBTC-USDC,WMATIC-USDC,USDCe-USDT,DAI-USDC'),
  SECONDARY_PAIR_IDS: optional('SECONDARY_PAIR_IDS', 'LINK-USDC,AAVE-USDC,GHST-USDC,QUICK-USDC'),
  SECONDARY_MAX_POSITION_USD: optionalNumber('SECONDARY_MAX_POSITION_USD', 100),
  MAX_OPPORTUNITY_AGE_MS: optionalNumber('MAX_OPPORTUNITY_AGE_MS', 100000),

  // Optimizer
  OPTIMIZER_SAMPLES: optionalNumber('OPTIMIZER_SAMPLES', 4),
  WORKER_POOL_SIZE: optionalNumber('WORKER_POOL_SIZE', 3),
  LP_MAX_PAIRS_PER_CYCLE: optionalNumber('LP_MAX_PAIRS_PER_CYCLE', 5),

  // Subgraph
  SUBGRAPH_API_KEY: optional('SUBGRAPH_API_KEY', ''),

  // Classic Incentive position size
  CLASSIC_INCENTIVE_POSITION_SIZE_USD: optionalNumber('CLASSIC_INCENTIVE_POSITION_SIZE_USD', 5000),

  // 🔥 NEW: Harvest + Spot Sell flashloan amount in USD
  HARVEST_FLASHLOAN_AMOUNT_USD: optionalNumber('HARVEST_FLASHLOAN_AMOUNT_USD', 5000),

  // 🔥 NEW: Maximum safe % of pool depth for flashloan (1-2%)
  HARVEST_MAX_POOL_DEPTH_PCT: optionalNumber('HARVEST_MAX_POOL_DEPTH_PCT', 1.5),

  // 🔥 NEW: Flashloan protocol to use (morpho-markets-v1, aave-v3, balancer-v3)
  HARVEST_FLASHLOAN_PROTOCOL: optional('HARVEST_FLASHLOAN_PROTOCOL', 'morpho-markets-v1'),
};