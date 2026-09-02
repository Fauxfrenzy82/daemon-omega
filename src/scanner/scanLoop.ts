// src/scanner/scanLoop.ts

import { createLogger } from '../utils/logger';
import { recordScanCycle } from '../utils/healthServer';
import { evaluateCircuitBreaker, isBreakerTripped } from '../risk/circuitBreaker';
import { hasExecutionCapacity } from '../execution/concurrency';
import { env } from '../config/env';
import { fetchNativePriceUsd } from '../config/priceFeeds';
import { OpportunityCandidate } from '../strategies/common/opportunityCandidate';
import { discoverArbitrage } from '../strategies/arbitrage/discover';

const log = createLogger('scanLoop');

let loopTimer: NodeJS.Timeout | null = null;
let isScanning = false;
let cachedNativePrice = 0.5;
let scanStartTime = 0;

// Helper function to check if a strategy is enabled
function isStrategyEnabled(strategyEnvVar: boolean): boolean {
  return env.MASTER_STRATEGY_ENABLED && strategyEnvVar;
}

// All strategies (only arbitrage active)
const discoverers = [
  { 
    name: 'Arbitrage', 
    fn: discoverArbitrage, 
    enabled: true,
    description: 'Triangular + Cross-DEX arbitrage'
  },
];

async function runScanCycle(): Promise<void> {
  if (isScanning) {
    log.warn('Scan cycle already running, skipping this tick');
    return;
  }
  isScanning = true;
  scanStartTime = Date.now();

  try {
    recordScanCycle();

    // Update native price at start of each cycle
    try {
      cachedNativePrice = await fetchNativePriceUsd();
    } catch (err) {
      log.warn('Using cached native price', { price: cachedNativePrice });
    }

    await evaluateCircuitBreaker();
    if (isBreakerTripped()) {
      log.warn('Circuit breaker active, skipping scan');
      return;
    }

    if (!hasExecutionCapacity()) {
      log.debug('At execution capacity, skipping scan');
      return;
    }

    log.info('🔍 Scan cycle started', { nativePrice: cachedNativePrice });

    const active = discoverers.filter(d => d.enabled);
    if (active.length === 0) {
      log.warn('⚠️ No strategies enabled — scan loop is idle.');
      return;
    }

    const strategyResults: Record<string, { candidates: number, status: string, note?: string }> = {};

    for (const discoverer of active) {
      let candidates: OpportunityCandidate[] = [];
      let status = 'success';
      let note = '';

      try {
        log.info(`🔍 Running strategy: ${discoverer.name} (${discoverer.description})`);
        candidates = await discoverer.fn(cachedNativePrice);
        log.debug(`Strategy ${discoverer.name} found ${candidates.length} candidates`);
      } catch (err) {
        status = 'error';
        note = err instanceof Error ? err.message : String(err);
        log.error(`Strategy ${discoverer.name} failed`, { error: note });
      }

      strategyResults[discoverer.name] = {
        candidates: candidates.length,
        status,
        note: note || (candidates.length === 0 ? 'No candidates found' : ''),
      };
    }

    const duration = Date.now() - scanStartTime;
    log.info('📊 Scan cycle summary', {
      nativePrice: cachedNativePrice,
      totalCandidates: Object.values(strategyResults).reduce((sum, s) => sum + s.candidates, 0),
      strategies: strategyResults,
      durationMs: duration,
    });
  } finally {
    isScanning = false;
    // Schedule next cycle after the interval
    if (loopTimer) {
      clearTimeout(loopTimer);
      loopTimer = null;
    }
    loopTimer = setTimeout(() => {
      runScanCycle().catch((err) => {
        log.error('Scan cycle error', { error: err instanceof Error ? err.message : String(err) });
      });
    }, env.SCAN_INTERVAL_MS);
  }
}

export function startScanLoop(): void {
  if (loopTimer) return;
  const interval = env.SCAN_INTERVAL_MS ?? 15000;
  log.info('Starting scan loop', { intervalMs: interval });
  runScanCycle().catch((err) => {
    log.error('Scan cycle error', { error: err instanceof Error ? err.message : String(err) });
  });
}

export function stopScanLoop(): void {
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
    log.info('Scan loop stopped');
  }
}