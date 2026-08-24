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

const log = createLogger('main');

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const HOURLY_SUMMARY_MS = 60 * 60 * 1000;
const DAILY_SUMMARY_MS = 24 * 60 * 60 * 1000;

async function bootstrap(): Promise<void> {
  log.info('Starting Chronos/Enso arbitrage system (Daemon Omega v2)', {
    env: env.NODE_ENV,
    executionWallet: executionWallet.address,
    discordAlerts: isDiscordConfigured() ? 'enabled' : 'disabled',
    gasReserveUsd: env.SWEEP_KEEP_GAS_RESERVE_USD,
  });

  await initSchema();

  // ✅ Step 1: Initialize Enso first
  try {
    initEnsoClient();
    log.info('Enso client initialized successfully');
  } catch (err) {
    log.error('Failed to initialize Enso client', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  startHealthServer();

  // ✅ Step 2: Get initial native price BEFORE starting scan loop
  const nativePrice = await fetchNativePriceUsd();
  log.info('Initial native token price fetched', { nativePrice });

  // ✅ Step 3: Start worker pool (so workers are ready for candidates)
  startWorkerPool();

  // ✅ Step 4: Start scan loop (workers are already waiting)
  startScanLoop();

  await alertSystemStarted(executionWallet.address);

  // Sweep interval
  setInterval(async () => {
    try {
      const currentPrice = await fetchNativePriceUsd();
      await sweepAllProfitTokens(currentPrice);
    } catch (err) {
      log.error('Sweep cycle failed', { error: String(err) });
    }
  }, SWEEP_INTERVAL_MS);

  // Hourly summary
  setInterval(async () => {
    try {
      const summary = await getHourlySummary();
      await alertPeriodSummary(summary);
    } catch (err) {
      log.error('Hourly summary failed', { error: String(err) });
    }
  }, HOURLY_SUMMARY_MS);

  // Daily summary
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

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', { reason: String(reason) });
});

bootstrap().catch((err) => {
  log.error('Fatal bootstrap error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});