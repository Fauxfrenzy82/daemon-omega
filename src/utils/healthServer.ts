import http from 'http';
import { env } from '../config/env';
import { getActiveTradeCount } from '../execution/queue';
import { isBreakerTripped } from '../risk/circuitBreaker';
import { createLogger } from './logger';

const log = createLogger('healthServer');

const PORT = Number(process.env.PORT) || 3000;

let systemStartedAt = Date.now();
let lastScanCycleAt: number | null = null;

/**
 * Called by the scan loop after every cycle so /health can report
 * genuine liveness (not just "process is up") — if lastScanCycleAt
 * stops advancing, that's a real signal something is stuck even
 * though the HTTP server itself is still answering pings.
 */
export function recordScanCycle(): void {
  lastScanCycleAt = Date.now();
}

function buildStatus() {
  const now = Date.now();
  const secondsSinceLastScan = lastScanCycleAt ? Math.round((now - lastScanCycleAt) / 1000) : null;

  return {
    status: 'ok',
    uptimeSeconds: Math.round((now - systemStartedAt) / 1000),
    activeTrades: getActiveTradeCount(),
    circuitBreakerTripped: isBreakerTripped(),
    lastScanCycleSecondsAgo: secondsSinceLastScan,
    env: env.NODE_ENV,
  };
}

/**
 * Exists solely so Render's Web Service health checks (and an external
 * cron ping) have something to hit. This does not replace the scan
 * loop — it runs alongside it in the same process, purely as a liveness
 * signal. No trading logic lives here.
 */
export function startHealthServer(): void {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/' ) {
      const body = JSON.stringify(buildStatus());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  server.listen(PORT, () => {
    log.info('Health check server listening', { port: PORT });
  });

  server.on('error', (err) => {
    log.error('Health check server error', { error: err.message });
  });
}