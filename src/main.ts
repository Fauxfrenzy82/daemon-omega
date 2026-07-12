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

// Placeholder native price reference for gas/sweep costing until a
// dedicated price feed is wired in — see README "known gaps".
const NATIVE_USD_PRICE_PLACEHOLDER = 0.5;

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

  setInterval(() => {
    sweepAllProfitTokens(NATIVE_USD_PRICE_PLACEHOLDER).catch((err) => {
      log.error('Sweep cycle failed', { error: err instanceof Error ? err.message : String(err) });
    });
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
  log.error('Fatal bootstrap error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});