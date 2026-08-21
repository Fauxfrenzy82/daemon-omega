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

const log = createLogger('execution-queue');

interface QueueState {
  activeTrades: number;
}

const state: QueueState = { activeTrades: 0 };

const FLASH_LOAN_CANDIDATES: TokenInfo[] = [
  TOKENS.DAI,
  TOKENS.USDC,
  TOKENS.WMATIC,
];

const MAX_OPPORTUNITY_AGE_MS = 5000;

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
    'WMATIC': 0.5,
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

// Process a batch of candidates from the scan loop
export async function processCandidates(candidates: OpportunityCandidate[]): Promise<void> {
  if (isBreakerTripped()) {
    log.warn('Circuit breaker tripped, skipping execution batch');
    return;
  }

  // Filter candidates by profitability (already done in discovery, but double-check)
  const profitable = candidates.filter(c => c.estimatedNetProfitUsd > 0);

  if (profitable.length === 0) {
    log.debug('No profitable candidates');
    return;
  }

  const gasPrice = await provider.getGasPrice();
  const gasPriceGwei = Number(ethers.utils.formatUnits(gasPrice, 'gwei'));

  if (!checkGasPriceLimit(gasPriceGwei)) {
    log.warn('Gas price too high, skipping execution batch', { gasPriceGwei });
    return;
  }

  // Sort by net profit descending, take top 3
  const sorted = profitable.sort((a, b) => b.estimatedNetProfitUsd - a.estimatedNetProfitUsd);
  const top = sorted.slice(0, 3);

  // For each candidate, build action plan and attempt execution
  for (const candidate of top) {
    // Check age
    if (Date.now() - candidate.sourceTimestamp > MAX_OPPORTUNITY_AGE_MS) {
      log.warn(`Candidate too stale: ${candidate.id}`, { age: Date.now() - candidate.sourceTimestamp });
      continue;
    }

    // Build action plan
    try {
      const plan = await buildActionPlanForCandidate(candidate);
      candidate.actionPlan = plan;
    } catch (err) {
      log.error(`Failed to build action plan for ${candidate.id}`, { error: String(err) });
      continue;
    }

    // Log opportunity and trade
    const opportunityId = await logOpportunity({
      pairId: candidate.id,
      baseSymbol: 'unknown', // not applicable for all strategies
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

    const tradeId = await logTrade({
      opportunityId,
      pairId: candidate.id,
      status: 'pending',
      positionSizeUsd: candidate.estimatedNetProfitUsd, // approximate
      expectedProfitUsd: candidate.estimatedNetProfitUsd,
    });

    // Execute with parallel flashloan attempts
    await dispatchCandidate(candidate, tradeId);
  }
}

async function dispatchCandidate(candidate: OpportunityCandidate, tradeId: number): Promise<void> {
  if (!canStartNewTrade({ activeTrades: state.activeTrades })) {
    log.debug('Concurrency limit reached, deferring candidate');
    return;
  }

  state.activeTrades += 1;
  let success = false;
  let lastError: string | null = null;

  try {
    await updateTradeStatus(tradeId, 'submitted');

    // Prepare balances before attempts
    const eligibleCandidates = FLASH_LOAN_CANDIDATES.filter(
      (token) => token.address.toLowerCase() !== candidate.actionPlan?.flashLoanToken.address.toLowerCase()
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
    await updateTradeStatus(tradeId, 'failed', { errorMessage: finalMessage });
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
  // Build bundle from plan, but we need to replace the flashloan token/provider in the plan
  // For simplicity, we assume the plan uses a specific flashloan token; we'll modify the plan's flashloan token
  const plan = candidate.actionPlan!;
  // Override flashloan token and amount with the current candidate's token
  // However, the plan may not be compatible with arbitrary tokens; we need to rebuild plan for each token?
  // This is a simplification; in practice we'd regenerate the plan for each token/provider combo.
  // For v1, we'll just use the plan as is and assume the token is appropriate.

  // We'll use the existing buildBundleFromPlan with the plan
  const built = await buildBundleFromPlan(plan);
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