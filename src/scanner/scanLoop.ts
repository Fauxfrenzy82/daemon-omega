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

// List of strategy discover functions with enabled flags
const discoverers = [
  { name: 'LP Entry/Exit', fn: discoverLPEntryExit, enabled: env.STRATEGY_LP_ENABLED ?? true },
  { name: 'Vault Arbitrage', fn: discoverVaultArb, enabled: env.STRATEGY_VAULT_ENABLED ?? true },
  { name: 'Debt Position', fn: discoverDebtPosition, enabled: env.STRATEGY_DEBT_ENABLED ?? false },
  { name: 'Harvest + Spot Sell', fn: discoverHarvestShort, enabled: env.STRATEGY_HARVEST_ENABLED ?? true },
  { name: 'Classic Incentive', fn: discoverClassicIncentive, enabled: env.STRATEGY_CLASSIC_ENABLED ?? false },
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

  log.info('Scan cycle started', { nativePrice: cachedNativePrice });

  const allCandidates: OpportunityCandidate[] = [];
  const active = discoverers.filter(d => d.enabled);

  for (const discoverer of active) {
    try {
      const candidates = await discoverer.fn(cachedNativePrice);
      allCandidates.push(...candidates);
      log.debug(`Strategy ${discoverer.name} found ${candidates.length} candidates`);
    } catch (err) {
      log.error(`Strategy ${discoverer.name} failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('Scan cycle complete', {
    totalCandidates: allCandidates.length,
    nativePrice: cachedNativePrice,
    activeStrategies: active.map(d => d.name).join(', '),
  });

  if (allCandidates.length > 0) {
    const { processCandidates } = await import('../execution/queue');
    await processCandidates(allCandidates);
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