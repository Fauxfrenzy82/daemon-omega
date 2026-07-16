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

// Limit tokens to avoid hitting rate limits
const FLASH_LOAN_CANDIDATES: TokenInfo[] = [
  TOKENS.DAI,
  TOKENS.USDC,
  TOKENS.WMATIC,
  // TOKENS.USDCe,
  // TOKENS.USDT,
  // TOKENS.WETH,
  // TOKENS.WBTC,
];

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

// Delay helper
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

  const dispatchable = ranked.slice(0, 3); // Limit to 3 opportunities per batch
  const executions = dispatchable.map((opp) => dispatchOpportunity(opp));
  await Promise.allSettled(executions);
}

async function dispatchOpportunity(opp: EvaluatedOpportunity): Promise<void> {
  if (!canStartNewTrade({ activeTrades: state.activeTrades })) {
    log.debug('Concurrency limit reached, deferring opportunity', {
      pairId: opp.pair.id,
    });
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
    const priceUsd = getTokenPriceUsd(candidate);
    const amountInUnits = opp.positionSizeUsd / priceUsd;
    const flashLoanAmountRaw = ethers.utils
      .parseUnits(amountInUnits.toFixed(candidate.decimals), candidate.decimals)
      .toString();

    const humanAmount = Number(flashLoanAmountRaw) / 10 ** candidate.decimals;

    for (const provider of FLASH_LOAN_PROVIDERS) {
      try {
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

        await updateTradeStatus(tradeId, 'submitted');

        const result = await executeBundle(built);

        if (result.success) {
          await updateTradeStatus(tradeId, 'confirmed', {
            txHash: result.txHash,
            gasUsed: result.gasUsed ? Number(result.gasUsed) : undefined,
          });

          log.info(`✅ Trade executed with ${provider.name} / ${candidate.symbol}`, {
            pairId: opp.pair.id,
            txHash: result.txHash,
          });
          await alertTradeExecuted(
            opp.pair.id,
            opp.netProfitUsd,
            result.txHash ?? 'unknown'
          );
          success = true;
          break;
        } else {
          throw new Error(`Execution failed: ${result.errorMessage}`);
        }
      } catch (err: any) {
        const errorMessage = err?.message || String(err);
        log.warn(`❌ ${provider.name} / ${candidate.symbol} failed`, {
          pairId: opp.pair.id,
          error: errorMessage,
        });
        lastError = err;

        // Delay to avoid hitting rate limits
        await sleep(300);
      }
    }

    if (success) {
      break;
    }

    // Delay between different tokens as well
    await sleep(300);
  }

  if (!success) {
    const finalMessage = lastError?.message || 'All flash‑loan tokens and providers failed';
    await updateTradeStatus(tradeId, 'failed', { errorMessage: finalMessage });
    log.warn('❌ Trade failed after trying all candidates', {
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