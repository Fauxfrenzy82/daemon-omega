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

// --- TEMPORARY: BYPASS LIQUIDITY CHECK TO DIAGNOSE REAL ERRORS ---
const BYPASS_LIQUIDITY_CHECK = true; // <-- set to true to skip pre-check
// ----------------------------------------------------------------

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);

interface QueueState {
  activeTrades: number;
}

const state: QueueState = { activeTrades: 0 };

// Priority list of flash‑loan tokens – stablecoins first, then volatile
const FLASH_LOAN_CANDIDATES: TokenInfo[] = [
  TOKENS.DAI,
  TOKENS.USDCe,
  TOKENS.USDT,
  TOKENS.USDC,
  TOKENS.WMATIC,
  TOKENS.WETH,
  TOKENS.WBTC,
];

function getTokenPriceUsd(token: TokenInfo, opp: EvaluatedOpportunity): number {
  if (token.symbol === 'USDC' || token.symbol === 'USDC.e' || token.symbol === 'USDT' || token.symbol === 'DAI') {
    return 1.0;
  }
  const priceMap: Record<string, number> = {
    'WMATIC': 0.5,
    'WETH': 3000,
    'WBTC': 60000,
  };
  return priceMap[token.symbol] || 0.01;
}

export async function processOpportunityBatch(evaluated: EvaluatedOpportunity[]): Promise<void> {
  if (isBreakerTripped()) {
    log.warn('Circuit breaker tripped, skipping execution batch');
    return;
  }

  const ranked = rankExecutable(evaluated);
  if (ranked.length === 0) return;

  const gasPrice = await provider.getGasPrice();
  const gasPriceGwei = Number(ethers.utils.formatUnits(gasPrice, 'gwei'));
  if (!checkGasPriceLimit(gasPriceGwei)) {
    log.warn('Gas price too high, skipping execution batch', { gasPriceGwei });
    return;
  }

  const dispatchable = ranked.slice(0, 10);
  await Promise.allSettled(dispatchable.map(opp => dispatchOpportunity(opp)));
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

  let lastError: any = null;
  let success = false;

  for (const candidate of FLASH_LOAN_CANDIDATES) {
    try {
      const priceUsd = getTokenPriceUsd(candidate, opp);
      const amountInUnits = opp.positionSizeUsd / priceUsd;
      const flashLoanAmountRaw = ethers.utils
        .parseUnits(amountInUnits.toFixed(candidate.decimals), candidate.decimals)
        .toString();

      log.info(`Trying flash‑loan token: ${candidate.symbol}`, {
        pair: opp.pair.id,
        positionSizeUsd: opp.positionSizeUsd,
        priceUsd,
        amountInUnits,
        rawAmount: flashLoanAmountRaw,
      });

      // --- Skip liquidity check if bypass is enabled ---
      if (!BYPASS_LIQUIDITY_CHECK) {
        const liquidityCheck = await checkFlashLoanLiquidity(candidate, flashLoanAmountRaw);
        if (!liquidityCheck.isAvailable) {
          log.info(`Skipping ${candidate.symbol}: ${liquidityCheck.reason}`);
          continue;
        }
        log.info(`Token ${candidate.symbol} available on: ${liquidityCheck.availableProviders.join(', ')}`);
      } else {
        log.info(`Bypassing liquidity check for ${candidate.symbol}`);
      }

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
        log.info(`✅ Trade executed with ${candidate.symbol}`, { pairId: opp.pair.id, txHash: result.txHash });
        await alertTradeExecuted(opp.pair.id, opp.netProfitUsd, result.txHash ?? 'unknown');
        success = true;
        break;
      } else {
        throw new Error(`Execution failed with ${candidate.symbol}: ${result.errorMessage}`);
      }
    } catch (err: any) {
      const errorMessage = err?.message || String(err);
      const responseData = err?.response?.data;

      // Check if it's a flash‑loan capacity issue (we want to continue to next token)
      const isInsufficientCapacity =
        errorMessage.includes('insufficient borrowing capacity') ||
        (responseData && typeof responseData === 'string' && responseData.includes('insufficient borrowing capacity')) ||
        (responseData?.message && responseData.message.includes('insufficient borrowing capacity'));

      if (isInsufficientCapacity) {
        log.warn(`Token ${candidate.symbol} not flash‑loanable, trying next...`, { error: errorMessage });
        lastError = err;
        continue;
      } else {
        log.error(`Fatal error with ${candidate.symbol}, stopping`, { error: errorMessage });
        lastError = err;
        break;
      }
    }
  }

  if (!success) {
    const finalMessage = lastError
      ? (lastError?.response?.data?.message || lastError?.message || String(lastError))
      : 'All flash‑loan tokens failed';
    await updateTradeStatus(tradeId, 'failed', { errorMessage: finalMessage });
    log.warn('Trade failed after trying all candidates', { pairId: opp.pair.id, error: finalMessage });
    await alertTradeFailed(opp.pair.id, finalMessage);
  }

  state.activeTrades -= 1;
}

export function getActiveTradeCount(): number {
  return state.activeTrades;
}