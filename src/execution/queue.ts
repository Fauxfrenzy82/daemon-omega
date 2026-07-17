import { EvaluatedOpportunity, rankExecutable } from '../profitability/evaluator';
import { buildArbitrageBundle, FLASH_LOAN_PROVIDERS, FlashLoanProvider } from './ensoBuilder';
import { executeBundle } from './ensoRouter';
import { logOpportunity, logTrade, updateTradeStatus } from '../db/logger';
import { isBreakerTripped } from '../risk/circuitBreaker';
import { canStartNewTrade, checkGasPriceLimit } from '../risk/limits';
import { ethers } from 'ethers';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import { alertTradeExecuted, alertTradeFailed } from '../notifications/notifier';
import { TOKENS, TokenInfo } from '../config/tokens';
import { executionWallet } from '../treasury/wallets';

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

// A single up-front guard: if the opportunity is already this old by
// the time we're about to dispatch, don't bother — its quote is
// almost certainly stale. Since every candidate×provider combination
// now races in parallel (see below) rather than sequentially, actual
// dispatch normally starts within milliseconds of evaluation, so this
// is a generous safety net for abnormal delays (e.g. event-loop
// backpressure), not a tight per-step timer like before.
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
  const executions = dispatchable.map((opp) => dispatchOpportunity(opp));
  await Promise.allSettled(executions);
}

interface AttemptResult {
  txHash?: string;
  gasUsed?: string;
  providerName: string;
  candidate: TokenInfo;
}

async function attemptOne(
  opp: EvaluatedOpportunity,
  candidate: TokenInfo,
  provider: FlashLoanProvider
): Promise<AttemptResult> {
  const priceUsd = getTokenPriceUsd(candidate);
  const amountInUnits = opp.positionSizeUsd / priceUsd;
  const flashLoanAmountRaw = ethers.utils
    .parseUnits(amountInUnits.toFixed(candidate.decimals), candidate.decimals)
    .toString();

  const humanAmount = Number(flashLoanAmountRaw) / 10 ** candidate.decimals;

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
    txHash: result.txHash,
    gasUsed: result.gasUsed,
    providerName: provider.name,
    candidate,
  };
}

async function dispatchOpportunity(opp: EvaluatedOpportunity): Promise<void> {
  if (!canStartNewTrade({ activeTrades: state.activeTrades })) {
    log.debug('Concurrency limit reached, deferring opportunity', {
      pairId: opp.pair.id,
    });
    return;
  }

  const dispatchStartedAt = Date.now();
  const ageAtDispatch = dispatchStartedAt - opp.evaluatedAt;
  if (ageAtDispatch > MAX_OPPORTUNITY_AGE_MS) {
    log.warn(`⏱️ Opportunity too stale to dispatch`, {
      pairId: opp.pair.id,
      ageAtDispatch,
    });
    await alertTradeFailed(opp.pair.id, `Discarded before dispatch, already ${ageAtDispatch}ms old`);
    return;
  }

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

  const eligibleCandidates = FLASH_LOAN_CANDIDATES.filter(
    (candidate) => candidate.address.toLowerCase() !== opp.pair.base.address.toLowerCase()
  );

  // Capture balances of every candidate token BEFORE any attempt, so
  // whichever one ends up winning has a real "before" snapshot to
  // diff against. This is what previously never existed — the
  // reported profit was always the pre-trade estimate, never a
  // measured outcome. Best-effort: if a balance read fails, that
  // token just won't have an actual-profit figure available later.
  const balancesBefore = new Map<string, ethers.BigNumber>();
  await Promise.all(
    eligibleCandidates.map(async (candidate) => {
      try {
        const bal = await getTokenBalance(candidate);
        balancesBefore.set(candidate.symbol, bal);
      } catch (err) {
        log.debug('Failed to read pre-trade balance', {
          token: candidate.symbol,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );

  // Race EVERY candidate × provider combination simultaneously,
  // instead of trying candidates one at a time with each candidate's
  // providers also sequential. The prior sequential approach meant
  // each candidate took ~1.7-2s (waiting for both providers to fail
  // before moving on), so a 3000ms staleness cutoff only allowed
  // ~1.5 candidates before aborting — starving WMATIC of any real
  // chance and discarding otherwise-viable opportunities purely due
  // to our own retry structure, not real market staleness. Full
  // parallelization means total time-to-first-success (or
  // time-to-know-everything-failed) is roughly one round-trip, not
  // the sum of several.
  const allAttempts: Promise<AttemptResult>[] = [];
  for (const candidate of eligibleCandidates) {
    for (const flProvider of FLASH_LOAN_PROVIDERS) {
      allAttempts.push(attemptOne(opp, candidate, flProvider));
    }
  }

  let success = false;
  let lastError: string | null = null;

  try {
    await updateTradeStatus(tradeId, 'submitted');
    const winner = await Promise.any(allAttempts);

    // Measure REAL, on-chain profit: balance of the winning token
    // after the trade, minus its balance before. This replaces the
    // pre-trade estimate as the number that gets logged and alerted
    // — the estimate stays available in the opportunity log for
    // comparison, but is no longer presented as the outcome.
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
      pairId: opp.pair.id,
      txHash: winner.txHash,
      estimatedNetProfitUsd: opp.netProfitUsd.toFixed(4),
      actualNetProfitUsd: actualNetProfitUsd !== null ? actualNetProfitUsd.toFixed(4) : 'unavailable',
      totalElapsedMs: Date.now() - dispatchStartedAt,
    });

    await alertTradeExecuted(
      opp.pair.id,
      actualNetProfitUsd !== null ? actualNetProfitUsd : opp.netProfitUsd,
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