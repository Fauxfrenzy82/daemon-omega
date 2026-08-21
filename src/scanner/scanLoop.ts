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

// List of strategy discover functions
const discoverers = [
  { name: 'LP Entry/Exit', fn: discoverLPEntryExit },
  { name: 'Vault Arbitrage', fn: discoverVaultArb },
  { name: 'Debt Position', fn: discoverDebtPosition },
  { name: 'Harvest + Spot Sell', fn: discoverHarvestShort },
  { name: 'Classic Incentive', fn: discoverClassicIncentive },
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

  for (const discoverer of discoverers) {
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
  });

  if (allCandidates.length > 0) {
    // Pass to queue for execution
    const { processCandidates } = await import('../execution/queue');
    await processCandidates(allCandidates);
  }
}

export function startScanLoop(): void {
  if (loopHandle) return;
  log.info('Starting scan loop', { intervalMs: env.SCAN_INTERVAL_MS });
  loopHandle = setInterval(() => {
    runScanCycle().catch((err) => {
      log.error('Scan cycle error', { error: err instanceof Error ? err.message : String(err) });
    });
  }, env.SCAN_INTERVAL_MS);
}

export function stopScanLoop(): void {
  if (loopHandle) {
    clearInterval(loopHandle);
    loopHandle = null;
    log.info('Scan loop stopped');
  }
}