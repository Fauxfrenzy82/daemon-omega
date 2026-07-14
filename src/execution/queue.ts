import { EvaluatedOpportunity, rankExecutable } from '../profitability/evaluator';
import { executeViaRouter } from './router';
import { buildArbitrageLogics } from './logicBuilder';
import { logOpportunity, logTrade, updateTradeStatus } from '../db/logger';
import { isBreakerTripped } from '../risk/circuitBreaker';
import { canStartNewTrade, checkGasPriceLimit } from '../risk/limits';
import { ethers } from 'ethers';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';
import { alertTradeExecuted, alertTradeFailed } from '../notifications/notifier';
import { TOKENS, TokenInfo } from '../config/tokens';
import { checkFlashLoanLiquidity } from './liquidityChecker';

const log = createLogger('execution-queue');

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);

interface QueueState {
  activeTrades: number;
}

const state: QueueState = { activeTrades: 0 };

// Priority list of flash‑loan tokens to try (stablecoins only, priced ~$1)
const FLASH_LOAN_CANDIDATES: TokenInfo[] = [
  TOKENS.DAI,
  TOKENS.USDCe,
  TOKENS.USDT,
  TOKENS.USDC,
];

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

  // Try each flash‑loan token candidate until one succeeds
  let lastError: any = null;
  let success = false;

  for (const candidate of FLASH_LOAN_CANDIDATES) {
    try {
      const flashLoanAmountRaw = ethers.utils
        .parseUnits(opp.positionSizeUsd.toString(), candidate.decimals)
        .toString();

      // --- Pre‑check liquidity ---
      const liquidityCheck = await checkFlashLoanLiquidity(candidate, flashLoanAmountRaw);

      if (!liquidityCheck.isAvailable) {
        log.info(`Skipping ${candidate.symbol}: ${liquidityCheck.reason}`);
        continue; // Try next token
      }

      log.info(`Token ${candidate.symbol} is available for flash loans on: ${liquidityCheck.availableProviders.join(', ')}`);

      // Build the arbitrage logics with this candidate
      const built = await buildArbitrageLogics(
        opp,
        candidate,
        flashLoanAmountRaw,
        {
          buyRequiresRequote: opp.buyRequiresRequote || false,
          sellRequiresRequote: opp.sellRequiresRequote || false,
        }
      );

      await updateTradeStatus(tradeId, 'submitted');

      const result = await executeViaRouter(built);

      if (result.success) {
        await updateTradeStatus(tradeId, 'confirmed', {
          txHash: result.txHash,
          gasUsed: result.gasUsed ? Number(result.gasUsed) : undefined,
        });

        log.info(`Trade executed successfully with flash‑loan token ${candidate.symbol}`, {
          pairId: opp.pair.id,
          txHash: result.txHash,
        });
        await alertTradeExecuted(opp.pair.id, opp.netProfitUsd, result.txHash ?? 'unknown');
        success = true;
        break;
      } else {
        throw new Error(`Execution failed with ${candidate.symbol}: ${result.errorMessage}`);
      }
    } catch (err: any) {
      const errorMessage = err?.message || String(err);
      const responseData = err?.response?.data;

      const isInsufficientCapacity =
        errorMessage.includes('insufficient borrowing capacity') ||
        (responseData && typeof responseData === 'string' && responseData.includes('insufficient borrowing capacity')) ||
        (responseData?.message && responseData.message.includes('insufficient borrowing capacity'));

      if (isInsufficientCapacity) {
        log.warn(`Token ${candidate.symbol} is not flash‑loanable, trying next candidate...`, {
          pairId: opp.pair.id,
          error: errorMessage,
        });
        lastError = err;
        continue;
      } else {
        log.error(`Fatal error with token ${candidate.symbol}, stopping`, {
          pairId: opp.pair.id,
          error: errorMessage,
        });
        lastError = err;
        break;
      }
    }
  }

  // If we exhausted all candidates without success
  if (!success) {
    const finalMessage = lastError
      ? (lastError?.response?.data?.message || lastError?.message || String(lastError))
      : 'All flash‑loan tokens failed';
    await updateTradeStatus(tradeId, 'failed', { errorMessage: finalMessage });
    log.warn('Trade execution failed after trying all flash‑loan candidates', {
      pairId: opp.pair.id,
      error: finalMessage,
    });
    await alertTradeFailed(opp.pair.id, finalMessage);
  }

  state.activeTrades -= 1;
}

export function getActiveTradeCount(): number {
  return state.activeTrades;
}