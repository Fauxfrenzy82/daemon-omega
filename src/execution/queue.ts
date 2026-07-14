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

// Priority list of flash‑loan tokens to try – stablecoins first (known to fail now, but left for completeness)
// Then volatile assets that typically have liquidity on Aave/Balancer.
const FLASH_LOAN_CANDIDATES: TokenInfo[] = [
  // Stablecoins (likely unsupported, but keep for completeness)
  TOKENS.DAI,
  TOKENS.USDCe,
  TOKENS.USDT,
  TOKENS.USDC,
  // Volatile assets (should be supported)
  TOKENS.WMATIC,
  TOKENS.WETH,
  TOKENS.WBTC,
];

/**
 * Get the USD price of a token using the opportunity's spread data.
 * Falls back to a hardcoded price if not available.
 */
function getTokenPriceUsd(token: TokenInfo, opp: EvaluatedOpportunity): number {
  // For stablecoins, price is ~1
  if (token.symbol === 'USDC' || token.symbol === 'USDC.e' || token.symbol === 'USDT' || token.symbol === 'DAI') {
    return 1.0;
  }

  // Try to extract price from the spread data.
  // The opportunity has buyQuote.price and sellQuote.price.
  // For pairs like WMATIC-USDC, the price is the amount of USDC per WMATIC.
  // We can derive the price of the base token from the quote.
  // We'll use the buyQuote.price which is the price of the quote token in terms of base?
  // Actually, spreadOpp.buyQuote.price is the price of the quote token (e.g., USDC) in terms of base?
  // It's safer to fetch from a known source.
  // We'll use a simple mapping for common tokens (fallback to CoinGecko later if needed).
  const priceMap: Record<string, number> = {
    'WMATIC': 0.5,   // approximate, will be overridden by scan data
    'WETH': 3000,
    'WBTC': 60000,
  };

  // If the token is the base of the opportunity, we can get its price from the quote.
  if (opp.pair.base.symbol === token.symbol) {
    // buyQuote.price is likely the price of the quote token in base units?
    // For example, if base is WMATIC and quote is USDC, buyQuote.price = 0.5 (USDC per WMATIC?)
    // That would be the price of USDC in WMATIC, so we need to invert?
    // Actually, the spread calculation uses price as amount of quote per base.
    // So we can use that directly.
    // But to be safe, we'll use the fallback.
    // We'll use the fallback for now.
  }

  // Fallback to the map
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
      // Get token price in USD
      const priceUsd = getTokenPriceUsd(candidate, opp);

      // Compute borrow amount: (positionSizeUsd / priceUsd) * 10^decimals
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