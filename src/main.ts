import { env } from './config/env';
import { initSchema, closePool } from './db/client';
import { initProtocolink } from './execution/protocolinkClient';
import { startScanLoop, stopScanLoop } from './scanner/scanLoop';
import { sweepAllProfitTokens } from './treasury/sweep';
import { executionWallet } from './treasury/wallets';
import { alertSystemStarted, isDiscordConfigured } from './notifications/notifier';
import { startHealthServer } from './utils/healthServer';
import { createLogger } from './utils/logger';

const log = createLogger('main');

const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // periodic sweep, independent of scan cycle

/**
 * Fetches the live POL/USD price from CoinGecko.
 * Falls back to a safe default (0.50) if the API fails.
 */
async function getPolUsdPrice(): Promise<number> {
  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=matic-network&vs_currencies=usd',
      {
        headers: {
          'Accept': 'application/json',
        },
        // Timeout after 5 seconds
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!response.ok) {
      log.warn('CoinGecko API returned non-200 status', { status: response.status });
      return 0.50;
    }

    const data = await response.json();
    const price = data['matic-network']?.usd;

    if (price && typeof price === 'number' && price > 0) {
      log.debug('Live POL/USD price fetched', { price });
      return price;
    }

    log.warn('CoinGecko response missing price data', { data });
    return 0.50;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('Failed to fetch POL/USD price from CoinGecko, using fallback', {
      error: message,
      fallback: 0.50,
    });
    return 0.50;
  }
}

/**
 * Fetches live native token price with retry and caching.
 * The price is used for gas estimation and sweep calculations.
 */
async function getNativeUsdPriceWithRetry(attempts: number = 3): Promise<number> {
  let lastError: Error | null = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const price = await getPolUsdPrice();
      if (price > 0) return price;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log.warn(`Price fetch attempt ${i + 1} failed`, {
        error: lastError.message,
        retryIn: (i + 1) * 1000,
      });
      await new Promise((resolve) => setTimeout(resolve, (i + 1) * 1000));
    }
  }

  log.warn('All price fetch attempts failed, using fallback', {
    attempts,
    fallback: 0.50,
    lastError: lastError?.message,
  });
  return 0.50;
}

async function bootstrap(): Promise<void> {
  log.info('Starting Chronos/Protocolink arbitrage system', {
    env: env.NODE_ENV,
    executionWallet: executionWallet.address,
    discordAlerts: isDiscordConfigured() ? 'enabled' : 'disabled (logging only)',
  });

  await initSchema();
  initProtocolink();

  startHealthServer();

  await alertSystemStarted(executionWallet.address);

  startScanLoop();

  // Fetch live POL price once at startup for the sweep logic.
  // The price is re-fetched on every sweep cycle to stay current.
  const nativePrice = await getNativeUsdPriceWithRetry();
  log.info('Initial native token price fetched', { nativePrice });

  setInterval(async () => {
    try {
      // Re-fetch the latest price before each sweep cycle
      const currentPrice = await getNativeUsdPriceWithRetry();
      await sweepAllProfitTokens(currentPrice);
    } catch (err) {
      log.error('Sweep cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, SWEEP_INTERVAL_MS);

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