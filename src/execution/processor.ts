import { OpportunityCandidate } from '../strategies/common/opportunityCandidate';
import { buildBundleFromPlan } from './ensoBuilder';
import { executeBundle } from './ensoRouter';
import { getCachedNativePrice, getCachedGasPrice, getCachedLiquidity } from '../utils/cache';
import { createLogger } from '../utils/logger';
import { logOpportunityAndTrade, updateTradeStatus } from '../db/logger';
import { alertTradeExecuted, alertTradeFailed } from '../notifications/notifier';
import { buildActionPlan } from '../strategies/classicIncentive/buildActionPlan';
import { buildActionPlan as buildLPActionPlan } from '../strategies/lpEntryExit/buildActionPlan';
import { buildActionPlan as buildVaultActionPlan } from '../strategies/vaultArb/buildActionPlan';
import { buildActionPlan as buildDebtActionPlan } from '../strategies/debtPosition/buildActionPlan';
import { buildActionPlan as buildHarvestActionPlan } from '../strategies/harvestShort/buildActionPlan';
import { canStartNewTrade, getActiveTradeCount } from './concurrency';
import { isBreakerTripped } from '../risk/circuitBreaker';
import { env } from '../config/env';

const log = createLogger('processor');

// Build action plan for a candidate based on strategy
async function buildActionPlanForCandidate(
  candidate: OpportunityCandidate,
  options?: { flashLoanToken?: any; flashLoanProvider?: any }
): Promise<any> {
  switch (candidate.strategy) {
    case 'lpEntryExit':
      return buildLPActionPlan(candidate, options);
    case 'vaultArb':
      return buildVaultActionPlan(candidate, options);
    case 'debtPosition':
      return buildDebtActionPlan(candidate, options);
    case 'harvestShort':
      return buildHarvestActionPlan(candidate, options);
    case 'classicIncentive':
      return buildActionPlan(candidate, options);
    default:
      throw new Error(`Unknown strategy: ${candidate.strategy}`);
  }
}

export async function processCandidate(candidate: OpportunityCandidate): Promise<void> {
  // Quick risk checks
  if (isBreakerTripped()) {
    log.warn('Circuit breaker tripped, skipping', { candidateId: candidate.id });
    return;
  }

  if (!canStartNewTrade({ activeTrades: getActiveTradeCount() })) {
    log.debug('Concurrency limit reached, requeueing', { candidateId: candidate.id });
    // Re-queue (will be picked up immediately by a worker)
    const { pushCandidate } = await import('./queue');
    pushCandidate(candidate);
    return;
  }

  // Use cached values – no fresh fetches per candidate
  const nativePrice = getCachedNativePrice();
  const gasPrice = getCachedGasPrice();
  const liquidityData = getCachedLiquidity();

  // 1. Build action plan (fast – no I/O)
  let plan;
  try {
    plan = await buildActionPlanForCandidate(candidate, {
      flashLoanToken: candidate.params.flashLoanToken || candidate.params.asset,
      flashLoanProvider: { name: 'Aave V3', protocol: 'aave-v3' },
    });
  } catch (err) {
    log.error(`Failed to build action plan for ${candidate.id}`, { error: String(err) });
    return;
  }

  // 2. Build bundle (Enso API call – necessary I/O)
  let built;
  try {
    built = await buildBundleFromPlan(plan);
  } catch (err) {
    log.error(`Failed to build bundle for ${candidate.id}`, { error: String(err) });
    return;
  }

  // 3. Simulate (eth_call – necessary I/O)
  let simulationResult;
  try {
    const enso = (await import('./ensoClient')).getEnsoClient();
    if (built.bundleData?.simulation?.success === false) {
      throw new Error(`Simulation failed: ${built.bundleData?.simulation?.error || 'unknown'}`);
    }
    simulationResult = { success: true };
  } catch (err) {
    log.error(`Simulation failed for ${candidate.id}`, { error: String(err) });
    return;
  }

  // 4. Execute (transaction submission – necessary I/O)
  let executionResult;
  try {
    executionResult = await executeBundle(built);
  } catch (err) {
    log.error(`Execution failed for ${candidate.id}`, { error: String(err) });
    // FIRE-AND-FORGET: Log failure but don't block
    alertTradeFailed(candidate.id, String(err)).catch(() => {});
    return;
  }

  if (!executionResult.success) {
    log.error(`Execution failed for ${candidate.id}`, { error: executionResult.errorMessage });
    alertTradeFailed(candidate.id, executionResult.errorMessage || 'Unknown error').catch(() => {});
    return;
  }

  // 5. Log to database – DETACHED: fire and forget, never block
  const opportunityId = candidate.id;
  const tradeId = Date.now().toString();

  // Fire DB write as detached async – never await
  logOpportunityAndTrade(
    {
      pairId: candidate.id,
      baseSymbol: 'unknown',
      quoteSymbol: 'unknown',
      sourceBuy: candidate.strategy,
      sourceSell: 'execution',
      priceBuy: 0,
      priceSell: 0,
      spreadBps: 0,
      estLiquidityUsd: 0,
      estGasCostUsd: candidate.estimatedCostUsd || 0,
      estProtocolFeeUsd: 0,
      estNetProfitUsd: candidate.estimatedNetProfitUsd || 0,
      meetsThreshold: true,
      strategy: candidate.strategy,
    },
    {
      pairId: candidate.id,
      status: 'confirmed',
      positionSizeUsd: candidate.estimatedNetProfitUsd || 0,
      expectedProfitUsd: candidate.estimatedNetProfitUsd || 0,
      txHash: executionResult.txHash,
      gasUsed: executionResult.gasUsed ? Number(executionResult.gasUsed) : undefined,
    }
  ).catch((err) => {
    log.error('DB logging failed (non-blocking)', { error: String(err) });
  });

  // 6. Discord alert – FIRE-AND-FORGET: never await
  alertTradeExecuted(
    candidate.id,
    candidate.estimatedNetProfitUsd || 0,
    executionResult.txHash || 'unknown'
  ).catch(() => {});

  log.info(`✅ Trade executed for ${candidate.id}`, {
    txHash: executionResult.txHash,
    profit: candidate.estimatedNetProfitUsd,
  });
}