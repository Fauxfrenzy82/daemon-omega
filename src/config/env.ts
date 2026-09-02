// src/config/env.ts

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
  // ============================================
  // BLOCKCHAIN / RPC (REQUIRED)
  // ============================================
  RPC_URL: required('RPC_URL'),
  RPC_WS_URL: optional('RPC_WS_URL', ''),
  CHAIN_ID: optionalNumber('CHAIN_ID', 137),

  // ============================================
  // PRIVATE MEMPOOL (MEV Protection)
  // ============================================
  PRIVATE_MEMPOOL_RPC: optional('PRIVATE_MEMPOOL_RPC', 'https://private-mempool.polygon.technology'),
  PRIVATE_MEMPOOL_URL: optional('PRIVATE_MEMPOOL_URL', 'https://private-mempool.polygon.technology'),

  // ============================================
  // WALLETS (REQUIRED)
  // ============================================
  EXECUTION_PRIVATE_KEY: required('EXECUTION_PRIVATE_KEY'),
  TREASURY_ADDRESS: required('TREASURY_ADDRESS'),

  // ============================================
  // ENSO (REQUIRED)
  // ============================================
  ENSO_API_KEY: required('ENSO_API_KEY'),
  ENSO_BASE_URL: normalizeEnsoBaseUrl(optional('ENSO_BASE_URL', 'https://api.enso.build/api')),
  USE_ENSO_ROUTE_PRIMARY: optionalBool('USE_ENSO_ROUTE_PRIMARY', true),
  ENSO_REQUEST_DELAY_MS: optionalNumber('ENSO_REQUEST_DELAY_MS', 800),

  // ============================================
  // DEX AGGREGATORS
  // ============================================
  PARASWAP_API_URL: optional('PARASWAP_API_URL', 'https://apiv5.paraswap.io'),
  OPENOCEAN_API_URL: optional('OPENOCEAN_API_URL', 'https://open-api.openocean.finance/v3/polygon'),
  ZEROEX_API_KEY: optional('ZEROEX_API_KEY', ''),

  // ============================================
  // DATABASE (REQUIRED)
  // ============================================
  DATABASE_URL: required('DATABASE_URL'),

  // ============================================
  // SUBGRAPH (kept but unused)
  // ============================================
  SUBGRAPH_API_KEY: optional('SUBGRAPH_API_KEY', ''),

  // ============================================
  // CLASSIC INCENTIVE – PROTOCOL ADDRESSES (kept but disabled)
  // ============================================
  BEEFY_VAULT_ADDRESS: optional('BEEFY_VAULT_ADDRESS', ''),
  BEEFY_WETH_VAULT: optional('BEEFY_WETH_VAULT', ''),
  CONVEX_ADDRESS: optional('CONVEX_ADDRESS', ''),
  HARVEST_VAULT_ADDRESS: optional('HARVEST_VAULT_ADDRESS', ''),
  QUICKSWAP_FARM_ADDRESS: optional('QUICKSWAP_FARM_ADDRESS', ''),
  BALANCER_GAUGE_ADDRESS: optional('BALANCER_GAUGE_ADDRESS', ''),
  CURVE_GAUGE_ADDRESS: optional('CURVE_GAUGE_ADDRESS', ''),
  MERKL_ADDRESS: optional('MERKL_ADDRESS', ''),
  MORPHO_ADDRESS: optional('MORPHO_ADDRESS', ''),

  // ============================================
  // RISK / THRESHOLDS
  // ============================================
  DEFAULT_MIN_PROFIT_USD: optionalNumber('DEFAULT_MIN_PROFIT_USD', 0.05),
  DEFAULT_MIN_SPREAD_BPS: optionalNumber('DEFAULT_MIN_SPREAD_BPS', 2),
  MAX_POSITION_SIZE_USD: optionalNumber('MAX_POSITION_SIZE_USD', 25000),
  MAX_CONCURRENT_TRADES: optionalNumber('MAX_CONCURRENT_TRADES', 3),
  MAX_SLIPPAGE_BPS: optionalNumber('MAX_SLIPPAGE_BPS', 300),
  MAX_PRICE_IMPACT_BPS: optionalNumber('MAX_PRICE_IMPACT_BPS', 300),

  // ============================================
  // CIRCUIT BREAKER
  // ============================================
  MAX_CONSECUTIVE_LOSSES: optionalNumber('MAX_CONSECUTIVE_LOSSES', 999),
  CIRCUIT_BREAKER_LOOKBACK_MINUTES: optionalNumber('CIRCUIT_BREAKER_LOOKBACK_MINUTES', 5),
  MAX_GAS_PRICE_GWEI: optionalNumber('MAX_GAS_PRICE_GWEI', 300),
  CIRCUIT_BREAKER_COOLDOWN_MS: optionalNumber('CIRCUIT_BREAKER_COOLDOWN_MS', 15 * 60 * 1000),

  // ============================================
  // SWEEP (Profit Collection)
  // ============================================
  SWEEP_ENABLED: optionalBool('SWEEP_ENABLED', true),
  SWEEP_MIN_BALANCE_USD: optionalNumber('SWEEP_MIN_BALANCE_USD', 2),
  SWEEP_KEEP_GAS_RESERVE_USD: optionalNumber('SWEEP_KEEP_GAS_RESERVE_USD', 1),
  SWEEP_TARGET_SYMBOL: optional('SWEEP_TARGET_SYMBOL', 'USDC'),
  SWEEP_DUST_THRESHOLD_USD: optionalNumber('SWEEP_DUST_THRESHOLD_USD', 0.01),

  // ============================================
  // ALERTS (Discord)
  // ============================================
  DISCORD_WEBHOOK_URL: optional('DISCORD_WEBHOOK_URL', ''),

  // ============================================
  // SCANNER
  // ============================================
  SCAN_INTERVAL_MS: optionalNumber('SCAN_INTERVAL_MS', 15000),
  LOG_LEVEL: optional('LOG_LEVEL', 'info'),
  NODE_ENV: optional('NODE_ENV', 'production'),

  // ============================================
  // MASTER STRATEGY TOGGLE
  // ============================================
  MASTER_STRATEGY_ENABLED: optionalBool('MASTER_STRATEGY_ENABLED', true),

  // ============================================
  // STRATEGY TOGGLES – Only rateArb and vaultArb are enabled
  // ============================================
  STRATEGY_RATE_ARB_ENABLED: optionalBool('STRATEGY_RATE_ARB_ENABLED', true),
  STRATEGY_VAULT_ARB_ENABLED: optionalBool('STRATEGY_VAULT_ARB_ENABLED', true),
  STRATEGY_LP_ENABLED: optionalBool('STRATEGY_LP_ENABLED', false),
  STRATEGY_DEBT_ENABLED: optionalBool('STRATEGY_DEBT_ENABLED', false),
  STRATEGY_HARVEST_ENABLED: optionalBool('STRATEGY_HARVEST_ENABLED', false),
  STRATEGY_CLASSIC_ENABLED: optionalBool('STRATEGY_CLASSIC_ENABLED', false),
  STRATEGY_ARBITRAGE_ENABLED: optionalBool('STRATEGY_ARBITRAGE_ENABLED', false), // disabled

  // ============================================
  // ARBITRAGE (TRIANGULAR) CONFIG (disabled)
  // ============================================
  ARBITRAGE_TEST_AMOUNTS: optional('ARBITRAGE_TEST_AMOUNTS', '25000,50000,100000,250000'),
  ARBITRAGE_MIN_PROFIT_USD: optionalNumber('ARBITRAGE_MIN_PROFIT_USD', 0.50),
  ARBITRAGE_RATE_LIMIT_MS: optionalNumber('ARBITRAGE_RATE_LIMIT_MS', 150),

  // ============================================
  // VAULT ARBITRAGE CONFIG
  // ============================================
  VAULT_ARB_MIN_PROFIT_USD: optionalNumber('VAULT_ARB_MIN_PROFIT_USD', 0.50),

  // ============================================
  // CLASSIC INCENTIVE (kept but disabled)
  // ============================================
  CLASSIC_INCENTIVE_MIN_PROFIT_USD: optionalNumber('CLASSIC_INCENTIVE_MIN_PROFIT_USD', 0.05),
  CLASSIC_INCENTIVE_MAX_PROTOCOLS: optionalNumber('CLASSIC_INCENTIVE_MAX_PROTOCOLS', 20),
  CLASSIC_INCENTIVE_POSITION_SIZE_USD: optionalNumber('CLASSIC_INCENTIVE_POSITION_SIZE_USD', 5000),

  // ============================================
  // OPTIMIZER / WORKERS
  // ============================================
  OPTIMIZER_SAMPLES: optionalNumber('OPTIMIZER_SAMPLES', 4),
  WORKER_POOL_SIZE: optionalNumber('WORKER_POOL_SIZE', 3),
  LP_MAX_PAIRS_PER_CYCLE: optionalNumber('LP_MAX_PAIRS_PER_CYCLE', 5),

  // ============================================
  // PAIRS (kept for reference)
  // ============================================
  PRIMARY_PAIR_IDS: optional('PRIMARY_PAIR_IDS', 'WETH-USDC,WBTC-USDC,WMATIC-USDC,USDCe-USDT,DAI-USDC'),
  SECONDARY_PAIR_IDS: optional('SECONDARY_PAIR_IDS', 'LINK-USDC,AAVE-USDC,GHST-USDC,QUICK-USDC'),
  SECONDARY_MAX_POSITION_USD: optionalNumber('SECONDARY_MAX_POSITION_USD', 100),
  MAX_OPPORTUNITY_AGE_MS: optionalNumber('MAX_OPPORTUNITY_AGE_MS', 100000),

  // ============================================
  // HARVEST (if ever re‑enabled)
  // ============================================
  HARVEST_FLASHLOAN_AMOUNT_USD: optionalNumber('HARVEST_FLASHLOAN_AMOUNT_USD', 5000),
  HARVEST_MAX_POOL_DEPTH_PCT: optionalNumber('HARVEST_MAX_POOL_DEPTH_PCT', 1.5),
  HARVEST_FLASHLOAN_PROTOCOL: optional('HARVEST_FLASHLOAN_PROTOCOL', 'morpho-markets-v1'),
};