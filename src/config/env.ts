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

export const env = {
  // Blockchain / RPC
  RPC_URL: required('RPC_URL'),
  RPC_WS_URL: optional('RPC_WS_URL', ''),
  CHAIN_ID: optionalNumber('CHAIN_ID', 137),

  // Wallets
  EXECUTION_PRIVATE_KEY: required('EXECUTION_PRIVATE_KEY'),
  TREASURY_ADDRESS: required('TREASURY_ADDRESS'),

  // --- Enso ---
  ENSO_API_KEY: required('ENSO_API_KEY'),
  ENSO_BASE_URL: optional('ENSO_BASE_URL', 'https://api.enso.finance'),

  // ParaSwap / OpenOcean (keep for price scanning)
  PARASWAP_API_URL: optional('PARASWAP_API_URL', 'https://apiv5.paraswap.io'),
  OPENOCEAN_API_URL: optional('OPENOCEAN_API_URL', 'https://open-api.openocean.finance/v3/polygon'),
  ZEROEX_API_KEY: optional('ZEROEX_API_KEY', ''),

  // Database
  DATABASE_URL: required('DATABASE_URL'),

  // Risk / thresholds
  DEFAULT_MIN_PROFIT_USD: optionalNumber('MIN_PROFIT_USD', 0.05),
  DEFAULT_MIN_SPREAD_BPS: optionalNumber('MIN_SPREAD_BPS', 2),
  MAX_POSITION_SIZE_USD: optionalNumber('MAX_POSITION_SIZE_USD', 10000), // new ceiling
  MAX_CONCURRENT_TRADES: optionalNumber('MAX_CONCURRENT_TRADES', 3),
  MAX_SLIPPAGE_BPS: optionalNumber('MAX_SLIPPAGE_BPS', 300),

  // Venue liquidity filter — do NOT raise this
  MAX_PRICE_IMPACT_BPS: optionalNumber('MAX_PRICE_IMPACT_BPS', 300),

  // Circuit breaker
  MAX_CONSECUTIVE_LOSSES: optionalNumber('MAX_CONSECUTIVE_LOSSES', 999),
  CIRCUIT_BREAKER_LOOKBACK_MINUTES: optionalNumber('CIRCUIT_BREAKER_LOOKBACK_MINUTES', 5),
  MAX_GAS_PRICE_GWEI: optionalNumber('MAX_GAS_PRICE_GWEI', 300),
  CIRCUIT_BREAKER_COOLDOWN_MS: optionalNumber('CIRCUIT_BREAKER_COOLDOWN_MS', 15 * 60 * 1000),

  // Sweep
  SWEEP_ENABLED: optionalBool('SWEEP_ENABLED', false),
  SWEEP_MIN_BALANCE_USD: optionalNumber('SWEEP_MIN_BALANCE_USD', 20),
  SWEEP_KEEP_GAS_RESERVE_USD: optionalNumber('SWEEP_KEEP_GAS_RESERVE_USD', 1),
  SWEEP_TARGET_SYMBOL: optional('SWEEP_TARGET_SYMBOL', 'USDC'),
  SWEEP_DUST_THRESHOLD_USD: optionalNumber('SWEEP_DUST_THRESHOLD_USD', 0.01),

  // Alerts
  DISCORD_WEBHOOK_URL: optional('DISCORD_WEBHOOK_URL', ''),

  // Scanner
  SCAN_INTERVAL_MS: optionalNumber('SCAN_INTERVAL_MS', 15000),
  LOG_LEVEL: optional('LOG_LEVEL', 'info'),
  NODE_ENV: optional('NODE_ENV', 'production'),

  // --- NEW: Strategy toggles (disable compute-heavy strategies) ---
  STRATEGY_LP_ENABLED: optionalBool('STRATEGY_LP_ENABLED', true),
  STRATEGY_VAULT_ENABLED: optionalBool('STRATEGY_VAULT_ENABLED', true),
  STRATEGY_DEBT_ENABLED: optionalBool('STRATEGY_DEBT_ENABLED', false),
  STRATEGY_HARVEST_ENABLED: optionalBool('STRATEGY_HARVEST_ENABLED', true),
  STRATEGY_CLASSIC_ENABLED: optionalBool('STRATEGY_CLASSIC_ENABLED', false),

  // --- NEW: Enso route migration and pair tiers ---
  USE_ENSO_ROUTE_PRIMARY: optionalBool('USE_ENSO_ROUTE_PRIMARY', true), // use route API as primary
  ENSO_REQUEST_DELAY_MS: optionalNumber('ENSO_REQUEST_DELAY_MS', 800), // rate-limit backoff
  PRIMARY_PAIR_IDS: optional('PRIMARY_PAIR_IDS', 'WETH-USDC,WBTC-USDC,WMATIC-USDC,USDCe-USDT,DAI-USDC'),
  SECONDARY_PAIR_IDS: optional('SECONDARY_PAIR_IDS', 'LINK-USDC,AAVE-USDC,GHST-USDC,QUICK-USDC'),
  SECONDARY_MAX_POSITION_USD: optionalNumber('SECONDARY_MAX_POSITION_USD', 100), // cap for thin pairs
};