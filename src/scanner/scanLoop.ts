// src/scanner/scanLoop.ts

import { createLogger } from '../utils/logger';
import { recordScanCycle } from '../utils/healthServer';
import { evaluateCircuitBreaker, isBreakerTripped } from '../risk/circuitBreaker';
import { hasExecutionCapacity } from '../execution/concurrency';
import { env } from '../config/env';
import { fetchNativePriceUsd } from '../config/priceFeeds';
import { OpportunityCandidate } from '../strategies/common/opportunityCandidate';
import { discoverArbitrage } from '../strategies/arbitrage/discover';
// import { discoverClassicIncentive } from '../strategies/classicIncentive/discover';

const log = createLogger('scanLoop');

let loopTimer: NodeJS.Timeout | null = null;
let isScanning = false;
let cachedNativePrice = 0.5;

// Helper function to check if a strategy is enabled
function isStrategyEnabled(strategyEnvVar: boolean): boolean {
  return env.MASTER_STRATEGY_ENABLED && strategyEnvVar;
}

// All strategies with their enabled status derived from env + master toggle
const discoverers = [
  // Temporarily disabled Classic Incentive
  // { 
  //   name: 'Classic Incentive', 
  //   fn: discoverClassicIncentive, 
  //   enabled: isStrategyEnabled(env.STRATEGY_CLASSIC_ENABLED),
  //   description: 'Instant‑claim incentive programs'
  // },
  { 
    name: 'Arbitrage', 
    fn: discoverArbitrage, 
    enabled: true,
    description: 'Triangular + Cross-DEX arbitrage'
  },
];

async function runScanCycle(): Promise<void> {
  // Prevent overlapping cycles
  if (isScanning) {
    log.warn('Scan cycle already running, skipping this tick');
    return;
  }
  isScanning = true;

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

    // Filter to only enabled strategies
    const active = discoverers.filter(d => d.enabled);

    // If no strategies are enabled, log once and idle
    if (active.length === 0) {
      log.warn('⚠️ No strategies enabled — scan loop is idle. Set MASTER_STRATEGY_ENABLED=true and/or individual strategy flags to true.');
      return;
    }

    const strategyResults: Record<string, { candidates: number, status: string, note?: string }> = {};

    // Log which strategies are active
    log.info(`📋 Active strategies: ${active.map(d => d.name).join(', ')}`);

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

    log.info('📊 Scan cycle summary', {
      nativePrice: cachedNativePrice,
      totalCandidates: Object.values(strategyResults).reduce((sum, s) => sum + s.candidates, 0),
      strategies: strategyResults,
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