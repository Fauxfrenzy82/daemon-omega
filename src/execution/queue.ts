import { EvaluatedOpportunity, rankExecutable } from '../profitability/evaluator';
import { executeViaRouter } from './router';
import { buildArbitrageLogics } from './logicBuilder';
import { logOpportunity, logTrade, updateTradeStatus } from '../db/logger';
import { isBreakerTripped } from '../risk/circuitBreaker';
import { canStartNewTrade, checkGasPriceLimit } from '../risk/limits';
import { ethers } from 'ethers';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';

const log = createLogger('execution-queue');

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);

interface QueueState {
  activeTrades: number;
}

const state: QueueState = { activeTrades: 0 };

export async function processOpportunityBatch(evaluated: EvaluatedOpportunity[]): Promise<void> {
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

  const dispatchable = ranked.slice(0, Math.max(0, 10));

  const executions = dispatchable.map((opp) => dispatchOpportunity(opp));
  await Promise.allSettled(executions);
}

async function dispatchOpportunity(opp: EvaluatedOpportunity): Promise<void> {
  if (!canStartNewTrade({ activeTrades: state.activeTrades })) {
    log.debug('Concurrency limit reached, deferring opportunity', { pairId: opp.pair.id });
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

  try {
    // The quote token for every configured pair is a USD-pegged stable
    // (USDC / USDC.e / USDT / DAI), so positionSizeUsd maps directly to
    // that token's raw units — no price division needed here. The
    // previous version divided positionSizeUsd by buyQuote.price, but
    // that price is denominated as base-token-per-quote-token (e.g.
    // WETH per USDC, a tiny fraction), which inflated the flashloan
    // amount by orders of magnitude — this was the actual cause of
    // ParaSwap's "no route found or price impact too high" errors,
    // not a real routing problem.
    const flashLoanAmountRaw = ethers.utils
      .parseUnits(
        opp.positionSizeUsd.toFixed(opp.pair.quote.decimals),
        opp.pair.quote.decimals
      )
      .toString();

    const built = await buildArbitrageLogics(opp, opp.pair.quote, flashLoanAmountRaw);

    await updateTradeStatus(tradeId, 'submitted');

    const result = await executeViaRouter(built);

    if (result.success) {
      await updateTradeStatus(tradeId, 'confirmed', {
        txHash: result.txHash,
        gasUsed: result.gasUsed ? Number(result.gasUsed) : undefined,
      });
      log.info('Trade executed successfully', { pairId: opp.pair.id, txHash: result.txHash });
    } else {
      await updateTradeStatus(tradeId, 'failed', {
        errorMessage: result.errorMessage,
        txHash: result.txHash,
      });
      log.warn('Trade execution failed', { pairId: opp.pair.id, error: result.errorMessage });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateTradeStatus(tradeId, 'failed', { errorMessage: message });
    log.error('Trade dispatch threw an error', { pairId: opp.pair.id, error: message });
  } finally {
    state.activeTrades -= 1;
  }
}

export function getActiveTradeCount(): number {
  return state.activeTrades;
}