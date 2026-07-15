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

  // --- Enso (replaces Protocolink) ---
  ENSO_API_KEY: required('ENSO_API_KEY'), // Get from https://developers.enso.build
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
  MAX_POSITION_SIZE_USD: optionalNumber('MAX_POSITION_SIZE_USD', 100),
  MAX_CONCURRENT_TRADES: optionalNumber('MAX_CONCURRENT_TRADES', 3),
  MAX_SLIPPAGE_BPS: optionalNumber('MAX_SLIPPAGE_BPS', 300),

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
};