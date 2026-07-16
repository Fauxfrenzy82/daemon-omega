import { EvaluatedOpportunity, rankExecutable } from '../profitability/evaluator';
import { buildArbitrageBundle, FLASH_LOAN_PROVIDERS } from './ensoBuilder';
import { executeBundle } from './ensoRouter';
import { logOpportunity, logTrade, updateTradeStatus } from '../db/logger';
import { isBreakerTripped } from '../risk/circuitBreaker';
import { canStartNewTrade, checkGasPriceLimit } from '../risk/limits';
import { ethers } from 'ethers';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import { alertTradeExecuted, alertTradeFailed } from '../notifications/notifier';
import { TOKENS, TokenInfo } from '../config/tokens';

const log = createLogger('execution-queue');

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);

interface QueueState {
  activeTrades: number;
}

const state: QueueState = { activeTrades: 0 };

const FLASH_LOAN_CANDIDATES: TokenInfo[] = [
  TOKENS.DAI,
  TOKENS.USDC,
  TOKENS.WMATIC,
];

// If more than this many ms have passed since the opportunity was
// evaluated, discard it rather than attempt execution — the quote is
// too likely to be stale. Production logs showed real repayment
// shortfalls (Enso's own simulation) even on trades that passed the
// evaluator's profit check, traced to 4-6+ seconds elapsing between
// evaluation and the eventual successful (or exhausted) attempt due
// to sequential, delayed flashloan-candidate retries. This is a hard
// backstop independent of the parallelization fix below.
const MAX_OPPORTUNITY_AGE_MS = 3000;

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

export async function processOpportunityBatch(
  evaluated: EvaluatedOpportunity[]
): Promise<void> {
  if (isBreakerTripped()) {
    log.warn('Circuit breaker tripped, skipping execution batch');
    return;
  }

  const ranked = rankExecutable(evaluated);
  if (ranked.length === 0) {
    return;
  }

  const gasPrice = await provider.getGasPrice();
  const gasPriceGwei = Number(ethers.utils.formatUnits(gasPrice, 'gwei'));

  if (!checkGasPriceLimit(gasPriceGwei)) {
    log.warn('Gas price too high, skipping execution batch', { gasPriceGwei });
    return;
  }

  const dispatchable = ranked.slice(0, 3);

  // Dispatch all opportunities in this batch immediately and in
  // parallel — no artificial stagger — since minimizing time between
  // evaluation and execution attempt is now the primary lever against
  // staleness-driven repayment shortfalls.
  const executions = dispatchable.map((opp) => dispatchOpportunity(opp));
  await Promise.allSettled(executions);
}

async function tryFlashLoanCandidate(
  opp: EvaluatedOpportunity,
  candidate: TokenInfo,
  tradeId: number
): Promise<{ success: true; txHash?: string; gasUsed?: string; providerName: string; candidateSymbol: string } | { success: false; error: string }> {
  const priceUsd = getTokenPriceUsd(candidate);
  const amountInUnits = opp.positionSizeUsd / priceUsd;
  const flashLoanAmountRaw = ethers.utils
    .parseUnits(amountInUnits.toFixed(candidate.decimals), candidate.decimals)
    .toString();

  const humanAmount = Number(flashLoanAmountRaw) / 10 ** candidate.decimals;

  // Race all providers for this candidate token in parallel — take
  // whichever succeeds first, rather than trying them one at a time
  // with delays between. Promise.any resolves on the first fulfilled
  // promise and only rejects if ALL of them reject.
  const attempts = FLASH_LOAN_PROVIDERS.map(async (provider) => {
    log.info(`🔁 Trying ${provider.name} flash loan with ${candidate.symbol}`, {
      pair: opp.pair.id,
      amount: humanAmount.toFixed(candidate.decimals > 6 ? 4 : 2),
    });

    const built = await buildArbitrageBundle(
      opp,
      candidate,
      flashLoanAmountRaw,
      provider,
      {
        buyRequiresRequote: opp.buyRequiresRequote || false,
        sellRequiresRequote: opp.sellRequiresRequote || false,
      }
    );

    const result = await executeBundle(built);

    if (!result.success) {
      throw new Error(`Execution failed: ${result.errorMessage}`);
    }

    return {
      success: true as const,
      txHash: result.txHash,
      gasUsed: result.gasUsed,
      providerName: provider.name,
      candidateSymbol: candidate.symbol,
    };
  });

  try {
    const winner = await Promise.any(attempts);
    return winner;
  } catch (aggregateErr: any) {
    // AggregateError from Promise.any — all providers failed for this
    // candidate token. Surface the first underlying error for logging.
    const firstError = aggregateErr?.errors?.[0];
    const errorMessage = firstError?.message || aggregateErr?.message || String(aggregateErr);
    return { success: false, error: errorMessage };
  }
}

async function dispatchOpportunity(opp: EvaluatedOpportunity): Promise<void> {
  if (!canStartNewTrade({ activeTrades: state.activeTrades })) {
    log.debug('Concurrency limit reached, deferring opportunity', {
      pairId: opp.pair.id,
    });
    return;
  }

  const dispatchStartedAt = Date.now();
  state.activeTrades += 1;

  const opportunityId = await logOpportunity({
    pairId: opp.pair.id,
    baseSymbol: opp.pair.base.symbol,
    quoteSymbol: opp.pair.quote.symbol,
    sourceBuy: opp.spreadOpp.buySource,
    sourceSell: opp.spreadOpp.sellSource,
    priceBuy: opp.spreadOpp.buyQuote.price,
    priceSell: opp.spreadOpp.sellQuote.price,
    spreadBps: opp.spreadOpp.spreadBps,
    estLiquidityUsd: opp.spreadOpp.buyQuote.estLiquidityUsd,
    estGasCostUsd: opp.gasCostUsd,
    estProtocolFeeUsd: opp.protocolFeeUsd,
    estNetProfitUsd: opp.netProfitUsd,
    meetsThreshold: opp.executable,
  });

  const tradeId = await logTrade({
    opportunityId,
    pairId: opp.pair.id,
    status: 'pending',
    positionSizeUsd: opp.positionSizeUsd,
    expectedProfitUsd: opp.netProfitUsd,
  });

  let lastError: string | null = null;
  let success = false;

  const eligibleCandidates = FLASH_LOAN_CANDIDATES.filter(
    (candidate) => candidate.address.toLowerCase() !== opp.pair.base.address.toLowerCase()
  );

  for (const candidate of eligibleCandidates) {
    const elapsedMs = Date.now() - dispatchStartedAt;
    if (elapsedMs > MAX_OPPORTUNITY_AGE_MS) {
      lastError = `Opportunity discarded as stale after ${elapsedMs}ms (max ${MAX_OPPORTUNITY_AGE_MS}ms)`;
      log.warn(`⏱️ Aborting further attempts — opportunity too stale`, {
        pairId: opp.pair.id,
        elapsedMs,
      });
      break;
    }

    const result = await tryFlashLoanCandidate(opp, candidate, tradeId);

    if (result.success) {
      await updateTradeStatus(tradeId, 'confirmed', {
        txHash: result.txHash,
        gasUsed: result.gasUsed ? Number(result.gasUsed) : undefined,
      });

      log.info(`✅ Trade executed with ${result.providerName} / ${result.candidateSymbol}`, {
        pairId: opp.pair.id,
        txHash: result.txHash,
        totalElapsedMs: Date.now() - dispatchStartedAt,
      });
      await alertTradeExecuted(opp.pair.id, opp.netProfitUsd, result.txHash ?? 'unknown');
      success = true;
      break;
    } else {
      log.warn(`❌ All providers failed for ${candidate.symbol}`, {
        pairId: opp.pair.id,
        error: result.error,
      });
      lastError = result.error;
    }
  }

  if (!success) {
    const finalMessage = lastError || 'All flash‑loan tokens and providers failed';
    await updateTradeStatus(tradeId, 'failed', { errorMessage: finalMessage });
    log.warn('❌ Trade failed after trying all candidates', {
      pairId: opp.pair.id,
      error: finalMessage,
      totalElapsedMs: Date.now() - dispatchStartedAt,
    });
    await alertTradeFailed(opp.pair.id, finalMessage);
  }

  state.activeTrades -= 1;
}

export function getActiveTradeCount(): number {
  return state.activeTrades;
}