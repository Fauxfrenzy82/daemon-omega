// src/scanner/scanLoop.ts
import { createLogger } from '../utils/logger';
import { recordScanCycle } from '../utils/healthServer';
import { evaluateCircuitBreaker, isBreakerTripped } from '../risk/circuitBreaker';
import { hasExecutionCapacity } from '../execution/concurrency';
import { env } from '../config/env';
import { fetchNativePriceUsd } from '../config/priceFeeds';
import { OpportunityCandidate } from '../strategies/common/opportunityCandidate';
import { discoverArbitrage } from '../strategies/arbitrage/discover';
import { discoverVaultArb } from '../strategies/vaultArb/discover';

const log = createLogger('scanLoop');

let loopTimer: NodeJS.Timeout | null = null;
let isScanning = false;
let cachedNativePrice = 0.5;

const discoverers = [
  {
    name: 'Triangular Arbitrage',
    fn: discoverArbitrage,
    enabled: env.STRATEGY_ARBITRAGE_ENABLED ?? true,
    description: 'USDC → TokenA → TokenB → USDC',
  },
  {
    name: 'Vault Arbitrage',
    fn: discoverVaultArb,
    enabled: env.STRATEGY_VAULT_ARB_ENABLED ?? true,
    description: 'StataToken wrapper arbitrage',
  },
];

async function runScanCycle() {
  if (isScanning) return;
  isScanning = true;
  try {
    recordScanCycle();
    cachedNativePrice = await fetchNativePriceUsd();
    await evaluateCircuitBreaker();
    if (isBreakerTripped()) return;
    if (!hasExecutionCapacity()) return;

    log.info('🔍 Scan cycle started', { nativePrice: cachedNativePrice });
    const active = discoverers.filter(d => d.enabled);
    if (!active.length) {
      log.warn('No strategies enabled');
      return;
    }

    const results: Record<string, any> = {};
    for (const d of active) {
      try {
        const candidates = await d.fn(cachedNativePrice);
        results[d.name] = { count: candidates.length, status: 'success' };
      } catch (err) {
        results[d.name] = { count: 0, status: 'error', error: String(err) };
      }
    }
    log.info('📊 Scan cycle summary', { results, durationMs: Date.now() - start });
  } finally {
    isScanning = false;
    loopTimer = setTimeout(runScanCycle, env.SCAN_INTERVAL_MS ?? 15000);
  }
}

export function startScanLoop() {
  if (!loopTimer) {
    log.info('Starting scan loop');
    runScanCycle();
  }
}
export function stopScanLoop() {
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}