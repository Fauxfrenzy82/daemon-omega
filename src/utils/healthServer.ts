import http from 'http';
import { env } from '../config/env';
import { getActiveTradeCount } from '../execution/queue';
import { isBreakerTripped } from '../risk/circuitBreaker';
import { createLogger } from './logger';

const log = createLogger('healthServer');

const PORT = Number(process.env.PORT) || 3000;

let systemStartedAt = Date.now();
let lastScanCycleAt: number | null = null;

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