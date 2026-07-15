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
import { checkFlashLoanLiquidity, FlashLoanAvailability } from './liquidityChecker';

const log = createLogger('execution-queue');

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);

interface QueueState {
  activeTrades: number;
}

const state: QueueState = { activeTrades: 0 };

const FLASH_LOAN_CANDIDATES: TokenInfo[] = [
  TOKENS.DAI,
  TOKENS.USDCe,
  TOKENS.USDT,
  TOKENS.USDC,
  TOKENS.WMATIC,
  TOKENS.WETH,
  TOKENS.WBTC,
];

/**
 * Per-scan-cycle cache of liquidity check results, keyed by
 * "tokenSymbol:rawAmount". Multiple pairs dispatched in the same
 * batch were each independently re-checking the exact same
 * token/amount combination — e.g. 5 pairs all separately asking
 * "is 500 USDC.e flash-loanable?" within milliseconds of each other,
 * producing the overlapping/duplicate log entries. Since liquidity
 * conditions don't meaningfully change within a single batch, this
 * cache means each unique check happens once and every other pair
 * needing the same answer reuses it — cutting redundant API calls
 * roughly in proportion to how many pairs share candidate tokens.
 * Cleared at the start of each processOpportunityBatch call so stale
 * results never persist across scan cycles.
 */
let liquidityCache = new Map<string, Promise<FlashLoanAvailability>>();

function getCachedLiquidityCheck(token: TokenInfo, amount: string): Promise<FlashLoanAvailability> {
  const key = `${token.symbol}:${amount}`;
  const cached = liquidityCache.get(key);
  if (cached) {
    return cached;
  }
  const promise = checkFlashLoanLiquidity(token, amount);
  liquidityCache.set(key, promise);
  return promise;
}

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

  if (ranked.length === 0) {
    return;
  }

  const gasPrice = await provider.getGasPrice();
  const gasPriceGwei = Number(ethers.utils.formatUnits(gasPrice, 'gwei'));

  if (!checkGasPriceLimit(gasPriceGwei)) {
    log.warn('Gas price too high, skipping execution batch', { gasPriceGwei });
    return;
  }

  // Fresh cache for this batch only — liquidity checks from a
  // previous scan cycle should never leak into this one.
  liquidityCache = new Map();

  const dispatchable = ranked.slice(0, Math.max(0, 10));

  // Stagger dispatch slightly instead of firing every pair in the
  // same instant. This doesn't change correctness (the liquidity
  // cache above already deduplicates identical concurrent requests
  // regardless), but it spreads genuinely distinct API calls
  // (different tokens, different amounts) out over a short window
  // rather than bursting all at once, which is gentler on rate-limited
  // dependencies elsewhere in the system (e.g. OpenOcean).
  const STAGGER_MS = 250;
  const executions = dispatchable.map((opp, index) =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        dispatchOpportunity(opp).finally(resolve);
      }, index * STAGGER_MS);
    })
  );

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

  let lastError: any = null;
  let success = false;

  for (const candidate of FLASH_LOAN_CANDIDATES) {
    try {
      const priceUsd = getTokenPriceUsd(candidate, opp);
      const amountInUnits = opp.positionSizeUsd / priceUsd;
      const flashLoanAmountRaw = ethers.utils
        .parseUnits(amountInUnits.toFixed(candidate.decimals), candidate.decimals)
        .toString();

      log.info(`Trying flash‑loan token: ${candidate.symbol} for pair ${opp.pair.id}`, {
        positionSizeUsd: opp.positionSizeUsd,
        priceUsd,
        amountInUnits,
        rawAmount: flashLoanAmountRaw,
      });

      const liquidityCheck = await getCachedLiquidityCheck(candidate, flashLoanAmountRaw);

      if (!liquidityCheck.isAvailable) {
        log.info(`Skipping ${candidate.symbol}: ${liquidityCheck.reason}`);
        continue;
      }

      log.info(`Token ${candidate.symbol} is available for flash loans on: ${liquidityCheck.availableProviders.join(', ')}`);

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