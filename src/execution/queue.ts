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

// Flash‑loan token candidates
const FLASH_LOAN_CANDIDATES: TokenInfo[] = [
  TOKENS.DAI,
  TOKENS.USDCe,
  TOKENS.USDT,
  TOKENS.USDC,
  TOKENS.WMATIC,
  TOKENS.WETH,
  TOKENS.WBTC,
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

export async function processOpportunityBatch(
  evaluated: EvaluatedOpportunity[]
): Promise<void> {
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
    sourceBuy: opp