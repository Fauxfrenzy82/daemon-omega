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

  // 1. Flash loan (Aave V3)
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

  // 2. Buy-side swap: use the scanner's buy quote (same amountIn)
  const buyQuote = opp.spreadOpp.buyQuote;
  const buyLogic = await buildBuySwapLogic(buyQuote.source, buyQuote);
  if (!buyLogic) {
    throw new Error(`Failed to build buy swap logic for source ${buyQuote.source}`);
  }
  logics.push(buyLogic);

  // 3. Sell-side swap: use the scanner's sell source, set amountIn = "auto"
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

async function buildBuySwapLogic(source: string, quote: any): Promise<any | null> {
  const chainId = getChainId();
  const tokenIn = quote.tokenIn;
  const tokenOut = quote.tokenOut;
  const amountIn = quote.amountIn;

  // Validate amount is not zero
  if (!amountIn || amountIn === '0' || BigInt(amountIn) === 0n) {
    log.warn('Buy swap amount is zero or invalid', {
      source,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amountIn,
    });
    return null;
  }

  try {
    const params = {
      input: { token: tokenIn, amount: amountIn },
      tokenOut: tokenOut,
    };

    log.debug('Requesting ParaSwap V5 quote', {
      source,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amountIn,
      tokenInAddress: tokenIn.address,
      tokenOutAddress: tokenOut.address,
    });

    const quotation = await withRetry(
      () => api.protocols.paraswapv5.getSwapTokenQuotation(chainId, params),
      {
        label: `paraswapv5.${tokenIn.symbol}->${tokenOut.symbol}`,
        shouldRetry: (err: any) => {
          // Don't retry on 400 (bad request) — it won't succeed
          if (err?.response?.status === 400) return false;
          return isTransientError(err);
        },
        retries: 2,
      }
    );
    return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
  } catch (err) {
    // Cast to any so we can access properties
    const error = err as any;
    const errorMsg = error?.message || String(err);
    const statusCode = error?.response?.status;
    const responseData = error?.response?.data;

    // Log full error details for debugging
    if (statusCode === 400) {
      log.error('🔴 ParaSwap V5 400 Bad Request — DETAILED:', {
        source,
        tokenIn: tokenIn.symbol,
        tokenOut: tokenOut.symbol,
        tokenInAddress: tokenIn.address,
        tokenOutAddress: tokenOut.address,
        amountIn,
        statusCode,
        response: typeof responseData === 'string' ? responseData : JSON.stringify(responseData, null, 2),
      });
      log.error('➡️  Full ParaSwap request params:', {
        tokenIn: tokenIn,
        tokenOut: tokenOut,
        amountIn,
      });
    } else {
      log.warn('Buy swap source failed', {
        source,
        tokenIn: tokenIn.symbol,
        tokenOut: tokenOut.symbol,
        error: errorMsg,
        statusCode,
      });
    }
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
    const params = {
      input: { token: tokenInObj, amount: amountIn },
      tokenOut: tokenOutObj,
    };

    const quotation = await withRetry(
      () => api.protocols.paraswapv5.getSwapTokenQuotation(chainId, params),
      {
        label: `paraswapv5.${tokenIn.symbol}->${tokenOut.symbol}`,
        shouldRetry: (err: any) => {
          if (err?.response?.status === 400) return false;
          return isTransientError(err);
        },
        retries: 2,
      }
    );
    return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
  } catch (err) {
    const error = err as any;
    const errorMsg = error?.message || String(err);
    const statusCode = error?.response?.status;
    const responseData = error?.response?.data;

    if (statusCode === 400) {
      log.error('🔴 ParaSwap V5 400 Bad Request (SELL) — DETAILED:', {
        source,
        tokenIn: tokenIn.symbol,
        tokenOut: tokenOut.symbol,
        tokenInAddress: tokenIn.address,
        tokenOutAddress: tokenOut.address,
        amountIn: 'auto',
        statusCode,
        response: typeof responseData === 'string' ? responseData : JSON.stringify(responseData, null, 2),
      });
      log.error('➡️  Full ParaSwap request params (SELL):', {
        tokenIn: tokenInObj,
        tokenOut: tokenOutObj,
        amountIn: 'auto',
      });
    } else {
      log.warn('Sell swap source failed', {
        source,
        tokenIn: tokenIn.symbol,
        tokenOut: tokenOut.symbol,
        error: errorMsg,
        statusCode,
      });
    }
    return null;
  }
}