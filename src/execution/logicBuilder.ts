import * as api from '@protocolink/api';
import { TokenInfo } from '../config/tokens';
import { EvaluatedOpportunity } from '../profitability/evaluator';
import { getChainId } from './protocolinkClient';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';

const log = createLogger('logicBuilder');

export interface BuiltLogics {
  logics: any[];
  flashLoanAmount: string;
  flashLoanToken: TokenInfo;
}

export async function buildArbitrageLogics(
  opp: EvaluatedOpportunity,
  flashLoanToken: TokenInfo,
  flashLoanAmountRaw: string
): Promise<BuiltLogics> {
  const chainId = getChainId();
  const logics: any[] = [];

  // 1. Flash loan
  const flashLoanLogic = await api.protocols.aavev3.newFlashLoanLogic({
    id: 'aave-v3-flashloan',
    isLoan: true,
    loans: [
      {
        token: {
          chainId,
          address: flashLoanToken.address,
          decimals: flashLoanToken.decimals,
          symbol: flashLoanToken.symbol,
          name: flashLoanToken.name,
        },
        amount: flashLoanAmountRaw,
      },
    ],
  });
  logics.push(flashLoanLogic);

  // 2. Buy swap — use scanner's quote amount
  const buyQuote = opp.spreadOpp.buyQuote;
  const buyLogic = await buildSwapLogic(buyQuote.source, buyQuote);
  if (!buyLogic) {
    throw new Error(`Failed to build buy swap logic for source ${buyQuote.source}`);
  }
  logics.push(buyLogic);

  // 3. Sell swap — use "auto" for chaining
  const sellSource = opp.spreadOpp.sellSource;
  const sellLogic = await buildSellSwapLogic(sellSource, opp.pair.base, opp.pair.quote);
  if (!sellLogic) {
    throw new Error(`Failed to build sell swap logic for source ${sellSource}`);
  }
  logics.push(sellLogic);

  log.info('Built arbitrage logic sequence', {
    pairId: opp.pair.id,
    buySource: buyQuote.source,
    sellSource,
    steps: logics.length,
  });

  return {
    logics,
    flashLoanAmount: flashLoanAmountRaw,
    flashLoanToken,
  };
}

async function buildSwapLogic(source: string, quote: any): Promise<any | null> {
  const chainId = getChainId();
  const tokenIn = quote.tokenIn;
  const tokenOut = quote.tokenOut;
  const amountIn = quote.amountIn;

  try {
    switch (source) {
      case 'paraswapv5': {
        const quotation = await withRetry(
          () => api.protocols.paraswapv5.getSwapTokenQuotation(chainId, {
            input: { token: tokenIn, amount: amountIn },
            tokenOut: tokenOut,
          }),
          { label: `paraswapv5.${tokenIn.symbol}->${tokenOut.symbol}`, shouldRetry: isTransientError, retries: 2 }
        );
        return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
      }
      case 'openoceanv2': {
        const quotation = await withRetry(
          () => api.protocols.openoceanv2.getSwapTokenQuotation(chainId, {
            input: { token: tokenIn, amount: amountIn },
            tokenOut: tokenOut,
          }),
          { label: `openoceanv2.${tokenIn.symbol}->${tokenOut.symbol}`, shouldRetry: isTransientError, retries: 2 }
        );
        return api.protocols.openoceanv2.newSwapTokenLogic(quotation);
      }
      default:
        log.warn('Unsupported swap source', { source });
        return null;
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.warn('Swap source failed', { source, error: errorMsg });
    return null;
  }
}

async function buildSellSwapLogic(source: string, tokenIn: TokenInfo, tokenOut: TokenInfo): Promise<any | null> {
  const chainId = getChainId();
  const tokenInObj = {
    chainId,
    address: tokenIn.address,
    decimals: tokenIn.decimals,
    symbol: tokenIn.symbol,
    name: tokenIn.name,
  };
  const tokenOutObj = {
    chainId,
    address: tokenOut.address,
    decimals: tokenOut.decimals,
    symbol: tokenOut.symbol,
    name: tokenOut.name,
  };

  try {
    const amountIn = 'auto';
    switch (source) {
      case 'paraswapv5': {
        const quotation = await withRetry(
          () => api.protocols.paraswapv5.getSwapTokenQuotation(chainId, {
            input: { token: tokenInObj, amount: amountIn },
            tokenOut: tokenOutObj,
          }),
          { label: `paraswapv5.${tokenIn.symbol}->${tokenOut.symbol}`, shouldRetry: isTransientError, retries: 2 }
        );
        return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
      }
      case 'openoceanv2': {
        const quotation = await withRetry(
          () => api.protocols.openoceanv2.getSwapTokenQuotation(chainId, {
            input: { token: tokenInObj, amount: amountIn },
            tokenOut: tokenOutObj,
          }),
          { label: `openoceanv2.${tokenIn.symbol}->${tokenOut.symbol}`, shouldRetry: isTransientError, retries: 2 }
        );
        return api.protocols.openoceanv2.newSwapTokenLogic(quotation);
      }
      default:
        log.warn('Unsupported swap source for sell', { source });
        return null;
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.warn('Sell swap source failed', { source, error: errorMsg });
    return null;
  }
}