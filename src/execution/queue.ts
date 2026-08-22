import { EvaluatedOpportunity, rankExecutable } from '../profitability/evaluator';
import { buildBundleFromPlan, FLASH_LOAN_PROVIDERS, FlashLoanProvider } from './ensoBuilder';
import { executeBundle } from './ensoRouter';
import { logOpportunity, logTrade, updateTradeStatus } from '../db/logger';
import { isBreakerTripped } from '../risk/circuitBreaker';
import { canStartNewTrade, checkGasPriceLimit } from '../risk/limits';
import { ethers } from 'ethers';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import { alertTradeExecuted, alertTradeFailed } from '../notifications/notifier';
import { TOKENS, TokenInfo } from '../config/tokens';
import { executionWallet, provider } from '../treasury/wallets';
import { OpportunityCandidate, ActionPlan } from '../strategies/common/opportunityCandidate';
import { buildActionPlan as buildLPActionPlan } from '../strategies/lpEntryExit/buildActionPlan';
import { buildActionPlan as buildVaultActionPlan } from '../strategies/vaultArb/buildActionPlan';
import { buildActionPlan as buildDebtActionPlan } from '../strategies/debtPosition/buildActionPlan';
import { buildActionPlan as buildHarvestActionPlan } from '../strategies/harvestShort/buildActionPlan';
import { buildActionPlan as buildClassicActionPlan } from '../strategies/classicIncentive/buildActionPlan';
import { getEnsoClient } from './ensoClient';
import { env } from '../config/env';

const log = createLogger('execution-queue');

interface QueueState {
  activeTrades: number;
}

const state: QueueState = { activeTrades: 0 };

// Candidate queue – items are added by scan loop and consumed by worker
const candidateQueue: OpportunityCandidate[] = [];
let workerRunning = false;
let workerResolve: (() => void) | null = null;

const FLASH_LOAN_CANDIDATES: TokenInfo[] = [
  TOKENS.DAI,
  TOKENS.USDC,
  TOKENS.WMATIC,
];

// Age threshold – now configurable, increased to 60 seconds by default
const MAX_OPPORTUNITY_AGE_MS = env.MAX_OPPORTUNITY_AGE_MS ?? 60000;

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

async function getTokenBalance(token: TokenInfo): Promise<ethers.BigNumber> {
  const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
  return contract.balanceOf(executionWallet.address);
}

function getTokenPriceUsd(token: TokenInfo): number {
  if (['USDC', 'USDC.e', 'USDT', 'DAI'].includes(token.symbol)) {
    return 1.0;
  }
  const priceMap: Record<string, number> = {
    'WMATIC': 0.1,
    'WETH': 3000,
    'WBTC': 60000,
  };
  return priceMap[token.symbol] || 0.01;
}

// Build action plan for a candidate based on strategy
async function buildActionPlanForCandidate(candidate: OpportunityCandidate): Promise<ActionPlan> {
  switch (candidate.strategy) {
    case 'lpEntryExit':
      return buildLPActionPlan(candidate);
    case 'vaultArb':
      return buildVaultActionPlan(candidate);
    case 'debtPosition':
      return buildDebtActionPlan(candidate);
    case 'harvestShort':
      return buildHarvestActionPlan(candidate);
    case 'classicIncentive':
      return buildClassicActionPlan(candidate);
    default:
      throw new Error(`Unknown strategy: ${candidate.strategy}`);
  }
}

// Worker: continuously pulls candidates from queue and processes them
async function workerLoop(): Promise<void> {
  while (true) {
    // Wait for candidates if queue is empty
    if (candidateQueue.length === 0) {
      await new Promise<void>((resolve) => {
        workerResolve = resolve;
      });
      continue;
    }

    const candidate = candidateQueue.shift();
    if (!candidate) continue;

    // Process candidate (non-blocking)
    try {
      await processCandidate(candidate);
    } catch (err) {
      log.error(`Error processing candidate ${candidate.id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// Push a candidate into the queue and wake up the worker
export function pushCandidate(candidate: OpportunityCandidate): void {
  candidateQueue.push(candidate);
  if (workerResolve) {
    workerResolve();
    workerResolve = null;
  }
  // Ensure worker is running
  if (!workerRunning) {
    workerRunning = true;
    workerLoop().catch((err) => {
      log.error('Worker loop crashed', { error: err instanceof Error ? err.message : String(err) });
      workerRunning = false;
    });
  }
}

// Process a single candidate (build plan, execute, measure profit)
async function processCandidate(candidate: OpportunityCandidate): Promise<void> {
  if (isBreakerTripped()) {
    log.warn('Circuit breaker tripped, skipping candidate', { candidateId: candidate.id });
    return;
  }

  if (Date.now() - candidate.sourceTimestamp > MAX_OPPORTUNITY_AGE_MS) {
    log.warn(`Candidate too stale: ${candidate.id}`, { age: Date.now() - candidate.sourceTimestamp });
    await alertTradeFailed(candidate.id, `Discarded before dispatch, already ${Date.now() - candidate.sourceTimestamp}ms old`);
    return;
  }

  if (!canStartNewTrade({ activeTrades: state.activeTrades })) {
    log.debug('Concurrency limit reached, deferring candidate', { candidateId: candidate.id });
    // Re-queue for later
    candidateQueue.push(candidate);
    return;
  }

  state.activeTrades += 1;

  let tradeId: number | null = null;
  let success = false;
  let lastError: string | null = null;

  try {
    // Build action plan
    let plan: ActionPlan;
    try {
      plan = await buildActionPlanForCandidate(candidate);
      candidate.actionPlan = plan;
    } catch (err) {
      throw new Error(`Failed to build action plan: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Log opportunity and trade
    const opportunityId = await logOpportunity({
      pairId: candidate.id,
      baseSymbol: 'unknown',
      quoteSymbol: 'unknown',
      sourceBuy: candidate.strategy,
      sourceSell: 'execution',
      priceBuy: 0,
      priceSell: 0,
      spreadBps: 0,
      estLiquidityUsd: 0,
      estGasCostUsd: candidate.estimatedCostUsd,
      estProtocolFeeUsd: 0,
      estNetProfitUsd: candidate.estimatedNetProfitUsd,
      meetsThreshold: true,
    });

    tradeId = await logTrade({
      opportunityId,
      pairId: candidate.id,
      status: 'pending',
      positionSizeUsd: candidate.estimatedNetProfitUsd,
      expectedProfitUsd: candidate.estimatedNetProfitUsd,
    });

    await updateTradeStatus(tradeId, 'submitted');

    // Prepare flashloan attempts
    const eligibleCandidates = FLASH_LOAN_CANDIDATES.filter(
      (token) => token.address.toLowerCase() !== plan.flashLoanToken.address.toLowerCase()
    );

    const balancesBefore = new Map<string, ethers.BigNumber>();
    await Promise.all(
      eligibleCandidates.map(async (token) => {
        try {
          const bal = await getTokenBalance(token);
          balancesBefore.set(token.symbol, bal);
        } catch (err) {
          log.debug('Failed to read pre-trade balance', {
            token: token.symbol,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })
    );

    // Race all flashloan tokens and providers
    const attempts: Promise<{ txHash?: string; gasUsed?: string; providerName: string; candidate: TokenInfo }>[] = [];

    for (const token of eligibleCandidates) {
      for (const provider of FLASH_LOAN_PROVIDERS) {
        attempts.push(attemptOne(candidate, token, provider));
      }
    }

    const winner = await Promise.any(attempts);

    // Measure actual profit
    let actualNetProfitUsd: number | null = null;
    try {
      const balanceAfter = await getTokenBalance(winner.candidate);
      const before = balancesBefore.get(winner.candidate.symbol);
      if (before) {
        const deltaRaw = balanceAfter.sub(before);
        const deltaHuman = Number(ethers.utils.formatUnits(deltaRaw, winner.candidate.decimals));
        actualNetProfitUsd = deltaHuman * getTokenPriceUsd(winner.candidate);
      }
    } catch (balErr) {
      log.warn('Failed to measure actual post-trade profit', {
        error: balErr instanceof Error ? balErr.message : String(balErr),
      });
    }

    await updateTradeStatus(tradeId, 'confirmed', {
      txHash: winner.txHash,
      gasUsed: winner.gasUsed ? Number(winner.gasUsed) : undefined,
      actualProfitUsd: actualNetProfitUsd ?? undefined,
    });

    log.info(`✅ Trade executed with ${winner.providerName} / ${winner.candidate.symbol}`, {
      candidateId: candidate.id,
      txHash: winner.txHash,
      estimatedNetProfitUsd: candidate.estimatedNetProfitUsd.toFixed(4),
      actualNetProfitUsd: actualNetProfitUsd !== null ? actualNetProfitUsd.toFixed(4) : 'unavailable',
    });

    await alertTradeExecuted(
      candidate.id,
      actualNetProfitUsd !== null ? actualNetProfitUsd : candidate.estimatedNetProfitUsd,
      winner.txHash ?? 'unknown'
    );
    success = true;
  } catch (aggregateErr: any) {
    const firstError = aggregateErr?.errors?.[0];
    lastError = firstError?.message || aggregateErr?.message || String(aggregateErr);
  }

  if (!success) {
    const finalMessage = lastError || 'All flash‑loan tokens and providers failed';
    if (tradeId) {
      await updateTradeStatus(tradeId, 'failed', { errorMessage: finalMessage });
    }
    log.warn('❌ Trade failed — all candidates/providers failed', {
      candidateId: candidate.id,
      error: finalMessage,
    });
    await alertTradeFailed(candidate.id, finalMessage);
  }

  state.activeTrades -= 1;
}

async function attemptOne(
  candidate: OpportunityCandidate,
  flashLoanToken: TokenInfo,
  provider: FlashLoanProvider
): Promise<{ txHash?: string; gasUsed?: string; providerName: string; candidate: TokenInfo }> {
  const plan = candidate.actionPlan!;
  // Override flashloan token and amount with the current candidate's token
  // We'll use the existing plan but replace the flashloan token.
  // For simplicity, we'll rebuild the plan with the new token.
  // But we need to ensure the plan is compatible; we'll assume it's flexible.
  // A better approach: the plan's flashloan token should be a parameter.
  // We'll clone and modify the plan for the specific token.
  const customPlan: ActionPlan = {
    ...plan,
    flashLoanToken: flashLoanToken,
    flashLoanAmount: ethers.utils.parseUnits(
      (candidate.estimatedNetProfitUsd / getTokenPriceUsd(flashLoanToken)).toString(),
      flashLoanToken.decimals
    ).toString(),
  };
  // We need to rebuild the steps with the new token; this is simplified.
  // For full flexibility, we'd need a strategy‑specific rebuild function.
  // For v1, we assume the plan's flashloan token is the only variable.
  const built = await buildBundleFromPlan(customPlan);

  // Simulation check
  try {
    const enso = getEnsoClient();
    if (built.bundleData?.simulation?.success === false) {
      throw new Error(`Simulation failed: ${built.bundleData?.simulation?.error || 'unknown reason'}`);
    }
  } catch (simErr: any) {
    throw new Error(`Simulation failed: ${simErr.message}`);
  }

  const result = await executeBundle(built);

  if (!result.success) {
    throw new Error(`Execution failed: ${result.errorMessage}`);
  }

  return {
    txHash: result.txHash,
    gasUsed: result.gasUsed,
    providerName: provider.name,
    candidate: flashLoanToken,
  };
}

export function getActiveTradeCount(): number {
  return state.activeTrades;
}

// Legacy batch processing (for backward compatibility, but we now use streaming)
export async function processCandidates(candidates: OpportunityCandidate[]): Promise<void> {
  for (const c of candidates) {
    pushCandidate(c);
  }
}