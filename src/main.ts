import { env } from './config/env';
import { initSchema, closePool } from './db/client';
import { initEnsoClient, getEnsoClient } from './execution/ensoClient';
import { startScanLoop, stopScanLoop } from './scanner/scanLoop';
import { sweepAllProfitTokens } from './treasury/sweep';
import { executionWallet } from './treasury/wallets';
import { alertSystemStarted, isDiscordConfigured, alertPeriodSummary } from './notifications/notifier';
import { startHealthServer } from './utils/healthServer';
import { createLogger } from './utils/logger';
// --- Added imports for summary generation ---
import { getHourlySummary, getDailySummary } from './reporting/summary';

const log = createLogger('main');

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const HOURLY_SUMMARY_MS = 60 * 60 * 1000;
const DAILY_SUMMARY_MS = 24 * 60 * 60 * 1000;

async function getPolUsdPrice(): Promise<number> {
  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=matic-network&vs_currencies=usd',
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!response.ok) {
      log.warn('CoinGecko API returned non-200 status', { status: response.status });
      return 0.08;
    }

    const data: any = await response.json();
    const price = data['matic-network']?.usd;

    if (price && typeof price === 'number' && price > 0) {
      return price;
    }

    log.warn('CoinGecko response missing price data, using fallback', { fallback: 0.08 });
    return 0.08;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('Failed to fetch POL/USD price, using fallback', {
      error: message,
      fallback: 0.08,
    });
    return 0.08;
  }
}

async function getNativeUsdPriceWithRetry(attempts: number = 3): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    try {
      const price = await getPolUsdPrice();
      if (price > 0) return price;
    } catch (err) {
      log.warn(`Price fetch attempt ${i + 1} failed`, {
        error: err instanceof Error ? err.message : String(err),
        retryIn: (i + 1) * 1000,
      });
      await new Promise((resolve) => setTimeout(resolve, (i + 1) * 1000));
    }
  }
  return 0.08;
}

async function bootstrap(): Promise<void> {
  log.info('Starting Chronos/Enso arbitrage system', {
    env: env.NODE_ENV,
    executionWallet: executionWallet.address,
    discordAlerts: isDiscordConfigured() ? 'enabled' : 'disabled',
    gasReserveUsd: env.SWEEP_KEEP_GAS_RESERVE_USD,
  });

  await initSchema();

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
  await alertSystemStarted(executionWallet.address);

  // ONE-TIME DIAGNOSTIC — deliberately loud and impossible to miss,
  // using plain console.log with unique START/END markers so it can
  // be found via a text search of the deploy log regardless of how
  // the log viewer paginates or truncates. Prints Enso's own live
  // action schemas rather than continuing to guess at request shape.
  log.info('=================================================');
  log.info('ENSO SCHEMA DIAGNOSTIC STARTING — SEARCH FOR ENSO_DIAGNOSTIC');
  log.info('=================================================');

  try {
    const enso = getEnsoClient();
    const allActions = await (enso as any).getActions();
    console.log('ENSO_DIAGNOSTIC_ALL_ACTIONS_START');
    console.log(JSON.stringify(allActions));
    console.log('ENSO_DIAGNOSTIC_ALL_ACTIONS_END');
  } catch (err) {
    console.log('ENSO_DIAGNOSTIC_ALL_ACTIONS_ERROR');
    console.log(String(err instanceof Error ? err.stack || err.message : err));
  }

  try {
    const enso = getEnsoClient();
    const aaveActions = await (enso as any).getActionsBySlug('aave-v3');
    console.log('ENSO_DIAGNOSTIC_AAVE_ACTIONS_START');
    console.log(JSON.stringify(aaveActions));
    console.log('ENSO_DIAGNOSTIC_AAVE_ACTIONS_END');
  } catch (err) {
    console.log('ENSO_DIAGNOSTIC_AAVE_ACTIONS_ERROR');
    console.log(String(err instanceof Error ? err.stack || err.message : err));
  }

  log.info('=================================================');
  log.info('ENSO SCHEMA DIAGNOSTIC COMPLETE');
  log.info('=================================================');

  startScanLoop();

  const nativePrice = await getNativeUsdPriceWithRetry();
  log.info('Initial native token price fetched', { nativePrice });

  // Sweep interval
  setInterval(async () => {
    try {
      const currentPrice = await getNativeUsdPriceWithRetry();
      await sweepAllProfitTokens(currentPrice);
    } catch (err) {
      log.error('Sweep cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, SWEEP_INTERVAL_MS);

  // --- Hourly summary interval ---
  setInterval(async () => {
    try {
      const summary = await getHourlySummary();
      await alertPeriodSummary(summary);
    } catch (err) {
      log.error('Hourly summary failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, HOURLY_SUMMARY_MS);

  // --- Daily summary interval ---
  setInterval(async () => {
    try {
      const summary = await getDailySummary();
      await alertPeriodSummary(summary);
    } catch (err) {
      log.error('Daily summary failed', {
        error: err instanceof Error ? err.message : String(err),
      });
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