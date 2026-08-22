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

let loopHandle: NodeJS.Timeout | null = null;
let cachedNativePrice = 0.5;

// List of strategy discover functions with enabled flags and names
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
    enabled: env.STRATEGY_DEBT_ENABLED ?? false,
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
    enabled: env.STRATEGY_CLASSIC_ENABLED ?? false,
    description: 'Instant‑claim incentive programs'
  },
];

async function runScanCycle(): Promise<void> {
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

  const allCandidates: OpportunityCandidate[] = [];
  const active = discoverers.filter(d => d.enabled);

  // Collect per‑strategy results for summary
  const strategyResults: Record<string, { candidates: number, status: string, note?: string }> = {};

  for (const discoverer of active) {
    const start = Date.now();
    let candidates: OpportunityCandidate[] = [];
    let status = 'success';
    let note = '';

    try {
      candidates = await discoverer.fn(cachedNativePrice);
      allCandidates.push(...candidates);
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

  // Summary log with clear visibility
  log.info('📊 Scan cycle summary', {
    nativePrice: cachedNativePrice,
    totalCandidates: allCandidates.length,
    strategies: strategyResults,
  });

  // If candidates exist, pass to queue
  if (allCandidates.length > 0) {
    const { processCandidates } = await import('../execution/queue');
    await processCandidates(allCandidates);
  } else {
    log.info('⛔ No candidates from any strategy this cycle');
  }
}

export function startScanLoop(): void {
  if (loopHandle) return;
  const interval = env.SCAN_INTERVAL_MS ?? 15000;
  log.info('Starting scan loop', { intervalMs: interval });
  loopHandle = setInterval(() => {
    runScanCycle().catch((err) => {
      log.error('Scan cycle error', { error: err instanceof Error ? err.message : String(err) });
    });
  }, interval);
}

export function stopScanLoop(): void {
  if (loopHandle) {
    clearInterval(loopHandle);
    loopHandle = null;
    log.info('Scan loop stopped');
  }
}