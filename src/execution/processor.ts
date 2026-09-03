// src/execution/processor.ts

import { OpportunityCandidate } from '../strategies/common/opportunityCandidate';
import { buildBundleFromPlan } from './ensoBuilder';
import { executeBundle } from './ensoRouter';
import { getCachedNativePrice, getCachedGasPrice, getCachedLiquidity } from '../utils/cache';
import { createLogger } from '../utils/logger';
import { logOpportunityAndTrade, updateTradeStatus } from '../db/logger';
import { alertTradeExecuted, alertTradeFailed } from '../notifications/notifier';
import { buildActionPlan as buildClassicIncentivePlan } from '../strategies/classicIncentive/buildActionPlan';
import { buildActionPlan as buildLPActionPlan } from '../strategies/lpEntryExit/buildActionPlan';
import { buildActionPlan as buildVaultActionPlan } from '../strategies/vaultArb/buildActionPlan';
import { buildActionPlan as buildDebtActionPlan } from '../strategies/debtPosition/buildActionPlan';
import { buildActionPlan as buildHarvestActionPlan } from '../strategies/harvestShort/buildActionPlan';
import { buildActionPlan as buildArbitragePlan } from '../strategies/arbitrage/buildActionPlan';
import { buildActionPlan as buildRateArbPlan } from '../strategies/rateArb/buildActionPlan';
import { canStartNewTrade, hasExecutionCapacity } from './concurrency';
import { incrementActiveTrades, decrementActiveTrades } from './queue';
import { isBreakerTripped } from '../risk/circuitBreaker';
import { env } from '../config/env';

const log = createLogger('processor');

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
      return buildClassicIncentivePlan(candidate, options);
    case 'arbitrage':
      return buildArbitragePlan(candidate, options);
    case 'rateArb':
      return buildRateArbPlan(candidate, options);
    default:
      throw new Error(`Unknown strategy: ${candidate.strategy}`);
  }
}

export async function processCandidate(candidate: OpportunityCandidate): Promise<void> {
  if (isBreakerTripped()) {
    log.warn('Circuit breaker tripped, skipping', { candidateId: candidate.id });
    return;
  }

  if (!hasExecutionCapacity()) {
    log.debug('Concurrency limit reached, requeueing', { candidateId: candidate.id });
    const { pushCandidate } = await import('./queue');
    pushCandidate(candidate);
    return;
  }

  incrementActiveTrades();

  try {
    const nativePrice = getCachedNativePrice();
    const gasPrice = getCachedGasPrice();
    const liquidityData = getCachedLiquidity();

    let plan;
    try {
      plan = await buildActionPlanForCandidate(candidate, {
        flashLoanToken: candidate.params.flashLoanToken || candidate.params.asset || candidate.params.tokenA,
        flashLoanProvider: { name: 'Morpho', protocol: 'morpho-markets-v1' },
      });
    } catch (err) {
      log.error(`Failed to build action plan for ${candidate.id}`, { error: String(err) });
      return;
    }

    let built;
    try {
      built = await buildBundleFromPlan(plan);
    } catch (err) {
      log.error(`Failed to build bundle for ${candidate.id}`, { error: String(err) });
      return;
    }

    try {
      const enso = (await import('./ensoClient')).getEnsoClient();
      if (built.bundleData?.simulation?.success === false) {
        throw new Error(`Simulation failed: ${built.bundleData?.simulation?.error || 'unknown'}`);
      }
    } catch (err) {
      log.error(`Simulation failed for ${candidate.id}`, { error: String(err) });
      return;
    }

    let executionResult;
    try {
      executionResult = await executeBundle(built);
    } catch (err) {
      log.error(`Execution failed for ${candidate.id}`, { error: String(err) });
      alertTradeFailed(candidate.id, String(err)).catch(() => {});
      return;
    }

    if (!executionResult.success) {
      log.error(`Execution failed for ${candidate.id}`, { error: executionResult.errorMessage });
      alertTradeFailed(candidate.id, executionResult.errorMessage || 'Unknown error').catch(() => {});
      return;
    }

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

    alertTradeExecuted(
      candidate.id,
      candidate.estimatedNetProfitUsd || 0,
      executionResult.txHash || 'unknown'
    ).catch(() => {});

    log.info(`✅ Trade executed for ${candidate.id}`, {
      txHash: executionResult.txHash,
      profit: candidate.estimatedNetProfitUsd,
    });
  } finally {
    decrementActiveTrades();
  }
}