import { env } from './config/env';
import { initSchema, closePool } from './db/client';
import { initEnsoClient, getEnsoClient } from './execution/ensoClient';
import { startScanLoop, stopScanLoop } from './scanner/scanLoop';
import { sweepAllProfitTokens } from './treasury/sweep';
import { executionWallet } from './treasury/wallets';
import { alertSystemStarted, isDiscordConfigured, alertPeriodSummary } from './notifications/notifier';
import { startHealthServer } from './utils/healthServer';
import { createLogger } from './utils/logger';
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

  // =====================================================
  // ENSO PROTOCOL SLUG TEST — ONE-TIME DIAGNOSTIC
  // Searches for ENSO_SLUG_DIAGNOSTIC in logs to see which
  // protocol slugs are available and what actions they return.
  // =====================================================
  log.info('=================================================');
  log.info('ENSO PROTOCOL SLUG TEST STARTING — SEARCH FOR ENSO_SLUG_DIAGNOSTIC');
  log.info('=================================================');

  // Already confirmed real from the prior run — not retested here.
  // CONFIRMED: uniswap-v2, uniswap-v3, sushiswap-v2, sushiswap-v3
  // CONFIRMED ABSENT: quickswap (clean "Invalid protocol slug" response)
  //
  // Everything below hit a 429 last time before getting a real answer —
  // genuinely untested, not confirmed absent. Retesting with a delay
  // between each call this time.
  const CANDIDATE_SLUGS = [
    'quickswap-v2', 'quickswap-v3', 'quick-swap', 'quickswap-uni-v2', 'quickswap-uni-v3',
    'dodo', 'dodo-v2', 'dodoex', 'dodo-v3',
    'balancer', 'balancer-v2', 'balancer-v3',
    'woofi', 'woofi-v2', 'woo-fi',
    'curve',
    'iron', 'iron-v2', 'ironswap',
    'kyberswap', 'kyberswap-elastic', 'kyberswap-classic',
    'ramses', 'ramses-v3',
    'aave-v3', 'morpho', 'morpho-markets-v1',
  ];

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const confirmedSlugs: string[] = [];
  const emptySlugs: string[] = [];
  const erroredSlugs: { slug: string; error: string }[] = [];

  for (const slug of CANDIDATE_SLUGS) {
    try {
      const enso = getEnsoClient();
      const actions = await (enso as any).getActionsBySlug(slug);
      if (Array.isArray(actions) && actions.length > 0) {
        confirmedSlugs.push(slug);
        console.log(`ENSO_SLUG_DIAGNOSTIC_HIT: ${slug} -> ${actions.length} actions -> ${JSON.stringify(actions.map((a: any) => a.action))}`);
      } else {
        emptySlugs.push(slug);
        console.log(`ENSO_SLUG_DIAGNOSTIC_EMPTY: ${slug}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      erroredSlugs.push({ slug, error: message });
      console.log(`ENSO_SLUG_DIAGNOSTIC_ERROR: ${slug} -> ${message}`);
    }

    // Pace requests to avoid the 429 that swallowed most of the last run.
    await sleep(600);
  }

  console.log('ENSO_SLUG_DIAGNOSTIC_SUMMARY_START');
  console.log(JSON.stringify({ confirmedSlugs, emptySlugs, erroredSlugs }));
  console.log('ENSO_SLUG_DIAGNOSTIC_SUMMARY_END');

  log.info('=================================================');
  log.info('ENSO PROTOCOL SLUG TEST COMPLETE');
  log.info('=================================================');

  startScanLoop();

  const nativePrice = await getNativeUsdPriceWithRetry();
  log.info('Initial native token price fetched', { nativePrice });

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