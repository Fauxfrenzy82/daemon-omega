import { createLogger } from '../utils/logger';
import { recordScanCycle } from '../utils/healthServer';
import { evaluateCircuitBreaker, isBreakerTripped } from '../risk/circuitBreaker';
import { hasExecutionCapacity } from '../execution/concurrency';
import { env } from '../config/env';
import { fetchNativePriceUsd } from '../config/priceFeeds';
import { OpportunityCandidate } from '../strategies/common/opportunityCandidate';
import { discoverLPEntryExit } from '../strategies/lpEntryExit/discover';
import { discoverVaultArb } from '../strategies/vaultArb/discover';
import { discoverDebtPosition } from '../strategies/debtPosition/discover';
import { discoverHarvestShort } from '../strategies/harvestShort/discover';
import { discoverClassicIncentive } from '../strategies/classicIncentive/discover';

const log = createLogger('scanLoop');

let loopTimer: NodeJS.Timeout | null = null;
let isScanning = false;
let cachedNativePrice = 0.5;

// All strategies enabled by default (fallback to true)
const discoverers = [
  { 
    name: 'LP Entry/Exit', 
    fn: discoverLPEntryExit, 
    enabled: env.STRATEGY_LP_ENABLED ?? true,
    description: 'DEX round‑trip arbitrage'
  },
  { 
    name: 'Vault Arbitrage', 
    fn: discoverVaultArb, 
    enabled: env.STRATEGY_VAULT_ENABLED ?? true,
    description: 'ERC‑4626 StataToken wrapper arbitrage'
  },
  { 
    name: 'Debt Position', 
    fn: discoverDebtPosition, 
    enabled: env.STRATEGY_DEBT_ENABLED ?? true,  // <-- CHANGED to true
    description: 'Aave V3 liquidation arbitrage'
  },
  { 
    name: 'Harvest + Spot Sell', 
    fn: discoverHarvestShort, 
    enabled: env.STRATEGY_HARVEST_ENABLED ?? true,
    description: 'Claim rewards and sell immediately'
  },
  { 
    name: 'Classic Incentive', 
    fn: discoverClassicIncentive, 
    enabled: env.STRATEGY_CLASSIC_ENABLED ?? true,  // <-- CHANGED to true
    description: 'Instant‑claim incentive programs'
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

    const active = discoverers.filter(d => d.enabled);
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
        // Push each candidate to queue immediately
        for (const candidate of candidates) {
          // The discover functions already call pushCandidate, so we don't need to push here
          // but we keep for summary
        }
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
  // Start first cycle immediately
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