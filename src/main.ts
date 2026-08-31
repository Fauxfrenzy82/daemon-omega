import { env } from './config/env';
import { initSchema, closePool } from './db/client';
import { initEnsoClient } from './execution/ensoClient';
import { startScanLoop, stopScanLoop } from './scanner/scanLoop';
import { startWorkerPool } from './execution/pool';
import { sweepAllProfitTokens } from './treasury/sweep';
import { executionWallet } from './treasury/wallets';
import { alertSystemStarted, isDiscordConfigured, alertPeriodSummary } from './notifications/notifier';
import { startHealthServer } from './utils/healthServer';
import { createLogger } from './utils/logger';
import { getHourlySummary, getDailySummary } from './reporting/summary';
import { fetchNativePriceUsd } from './config/priceFeeds';
import { initializeFarms } from './config/farms';

const log = createLogger('main');

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const HOURLY_SUMMARY_MS = 60 * 60 * 1000;
const DAILY_SUMMARY_MS = 24 * 60 * 60 * 1000;

// Helper to check if any strategy is enabled
function isAnyStrategyEnabled(): boolean {
  if (!env.MASTER_STRATEGY_ENABLED) return false;
  return (
    env.STRATEGY_CLASSIC_ENABLED ||
    env.STRATEGY_LP_ENABLED ||
    env.STRATEGY_VAULT_ENABLED ||
    env.STRATEGY_DEBT_ENABLED ||
    env.STRATEGY_HARVEST_ENABLED
  );
}

async function bootstrap(): Promise<void> {
  log.info('Starting Chronos/Enso arbitrage system (Daemon Omega v2)', {
    env: env.NODE_ENV,
    executionWallet: executionWallet.address,
    discordAlerts: isDiscordConfigured() ? 'enabled' : 'disabled',
    gasReserveUsd: env.SWEEP_KEEP_GAS_RESERVE_USD,
    masterEnabled: env.MASTER_STRATEGY_ENABLED,
    classicIncentiveEnabled: env.STRATEGY_CLASSIC_ENABLED,
  });

  // ✅ Initialize database schema
  await initSchema();

  // ✅ Step 1: Initialize Enso client
  try {
    initEnsoClient();
    log.info('Enso client initialized successfully');
  } catch (err) {
    log.error('Failed to initialize Enso client', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // ✅ Step 2: Initialize farms ONLY if Harvest is enabled
  if (env.STRATEGY_HARVEST_ENABLED && env.MASTER_STRATEGY_ENABLED) {
    try {
      await initializeFarms();
      log.info('Farms initialized successfully');
    } catch (err) {
      log.error('Failed to initialize farms', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Non-fatal: continue without farms
    }
  } else {
    log.info('Skipping farm initialization (Harvest strategy disabled or master toggle off)');
  }

  // ✅ Step 3: Start health server
  startHealthServer();

  // ✅ Step 4: Get initial native price BEFORE starting scan loop
  const nativePrice = await fetchNativePriceUsd();
  log.info('Initial native token price fetched', { nativePrice });

  // ✅ Step 5: Start worker pool (so workers are ready for candidates)
  // Only start if at least one strategy is enabled
  if (isAnyStrategyEnabled()) {
    startWorkerPool();
    log.info('Worker pool started');
  } else {
    log.warn('⚠️ No strategies enabled — worker pool NOT started. Set MASTER_STRATEGY_ENABLED=true and/or individual strategy flags to true.');
  }

  // ✅ Step 6: Start scan loop (workers are already waiting)
  startScanLoop();

  // ✅ Step 7: Send system started alert
  await alertSystemStarted(executionWallet.address);

  // ✅ Step 8: Sweep interval (profit collection)
  setInterval(async () => {
    try {
      const currentPrice = await fetchNativePriceUsd();
      await sweepAllProfitTokens(currentPrice);
    } catch (err) {
      log.error('Sweep cycle failed', { error: String(err) });
    }
  }, SWEEP_INTERVAL_MS);

  // ✅ Step 9: Hourly summary
  setInterval(async () => {
    try {
      const summary = await getHourlySummary();
      await alertPeriodSummary(summary);
    } catch (err) {
      log.error('Hourly summary failed', { error: String(err) });
    }
  }, HOURLY_SUMMARY_MS);

  // ✅ Step 10: Daily summary
  setInterval(async () => {
    try {
      const summary = await getDailySummary();
      await alertPeriodSummary(summary);
    } catch (err) {
      log.error('Daily summary failed', { error: String(err) });
    }
  }, DAILY_SUMMARY_MS);

  log.info('System running');
}

async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  stopScanLoop();
  await closePool();
  process.exit(0);
}

// ✅ Process signal handlers
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ✅ Unhandled rejection handler
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', { reason: String(reason) });
});

// ✅ Bootstrap the system
bootstrap().catch((err) => {
  log.error('Fatal bootstrap error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});