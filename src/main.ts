// src/main.ts

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
import { discoverAllProtocols } from './config/protocolDiscovery';
import { setDiscoveredProtocols } from './strategies/classicIncentive/protocolRegistry';

const log = createLogger('main');

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const HOURLY_SUMMARY_MS = 60 * 60 * 1000;
const DAILY_SUMMARY_MS = 24 * 60 * 60 * 1000;

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
  log.info('Starting Chronos/Enso arbitrage system (Daemon Omega v3)', {
    env: env.NODE_ENV,
    executionWallet: executionWallet.address,
    discordAlerts: isDiscordConfigured() ? 'enabled' : 'disabled',
    masterEnabled: env.MASTER_STRATEGY_ENABLED,
    classicIncentiveEnabled: env.STRATEGY_CLASSIC_ENABLED,
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

  if (env.STRATEGY_CLASSIC_ENABLED && env.MASTER_STRATEGY_ENABLED) {
    try {
      log.info('🔍 Running protocol self-discovery...');
      const discovered = await discoverAllProtocols();

      // Transform DiscoveredProtocol[] to ProtocolConfig[]
      const protocolConfigs = discovered.map(d => ({
        id: d.id,
        name: d.name,
        priority: d.priority,
        address: d.address,
        functions: d.functionNames.map(name => ({ name, signature: `${name}()` })),
        rewardToken: d.rewardToken,
        entryToken: d.entryToken,
        rewardType: 'harvest-triggered' as const,
        skipForCallerHarvest: false,
        abi: [],
        callerIncentiveBps: d.protocol === 'beefy' ? 200 : undefined,
      }));

      setDiscoveredProtocols(protocolConfigs);
      log.info(`✅ Protocol discovery complete: ${protocolConfigs.length} protocols registered`);
    } catch (err) {
      log.error('Failed to discover protocols', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  startHealthServer();

  const nativePrice = await fetchNativePriceUsd();
  log.info('Initial native token price fetched', { nativePrice });

  if (isAnyStrategyEnabled()) {
    startWorkerPool();
    log.info('Worker pool started');
  } else {
    log.warn('⚠️ No strategies enabled — worker pool NOT started');
  }

  startScanLoop();

  await alertSystemStarted(executionWallet.address);

  setInterval(async () => {
    try {
      const currentPrice = await fetchNativePriceUsd();
      await sweepAllProfitTokens(currentPrice);
    } catch (err) {
      log.error('Sweep cycle failed', { error: String(err) });
    }
  }, SWEEP_INTERVAL_MS);

  setInterval(async () => {
    try {
      const summary = await getHourlySummary();
      await alertPeriodSummary(summary);
    } catch (err) {
      log.error('Hourly summary failed', { error: String(err) });
    }
  }, HOURLY_SUMMARY_MS);

  setInterval(async () => {
    try {
      const summary = await getDailySummary();
      await alertPeriodSummary(summary);
    } catch (err) {
      log.error('Daily summary failed', { error: String(err) });
    }
  }, DAILY_SUMMARY_MS);

  log.info('✅ System running with self-discovered protocols');
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