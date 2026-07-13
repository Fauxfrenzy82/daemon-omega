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

function toProtocolinkToken(chainId: number, token: TokenInfo) {
  return {
    chainId,
    address: token.address,
    decimals: token.decimals,
    symbol: token.symbol,
    name: token.name,
  };
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
        token: toProtocolinkToken(chainId, flashLoanToken),
        amount: flashLoanAmountRaw,
      },
    ],
  });
  logics.push(flashLoanLogic);

  // 2. Buy-side swap: Use the scanner's actual source
  const buySource = opp.spreadOpp.buySource;
  const buyLogic = await buildSwapLogicWithRequote(
    buySource,
    opp.pair.quote,
    opp.pair.base,
    flashLoanAmountRaw,
    opp
  );
  if (!buyLogic) {
    throw new Error(`Failed to build buy swap logic for source ${buySource}`);
  }
  logics.push(buyLogic);

  // 3. Sell-side swap: Use the scanner's actual source
  const sellSource = opp.spreadOpp.sellSource;
  const buyOutputAmount = opp.spreadOpp.buyQuote.amountOut;
  const sellLogic = await buildSwapLogicWithRequote(
    sellSource,
    opp.pair.base,
    opp.pair.quote,
    buyOutputAmount,
    opp
  );
  if (!sellLogic) {
    throw new Error(`Failed to build sell swap logic for source ${sellSource}`);
  }
  logics.push(sellLogic);

  log.info('Built arbitrage logic sequence', {
    pairId: opp.pair.id,
    buySource,
    sellSource,
    steps: logics.length,
  });

  return {
    logics,
    flashLoanAmount: flashLoanAmountRaw,
    flashLoanToken,
  };
}

/**
 * Builds swap logic with a fresh re-quote at execution time.
 * This ensures the quote is still valid and profitable.
 */
async function buildSwapLogicWithRequote(
  source: string,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string,
  opp: EvaluatedOpportunity
): Promise<any | null> {
  const chainId = getChainId();
  const tokenInObj = toProtocolinkToken(chainId, tokenIn);
  const tokenOutObj = toProtocolinkToken(chainId, tokenOut);

  if (!amountIn || amountIn === '0') {
    log.warn('Swap amount is zero or invalid', {
      source,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amountIn,
    });
    return null;
  }

  log.info(`🔄 Fresh re-quote for ${source} (${tokenIn.symbol}→${tokenOut.symbol})`, {
    amountIn,
    positionSizeUsd: opp.positionSizeUsd,
  });

  const params = {
    input: { token: tokenInObj, amount: amountIn },
    tokenOut: tokenOutObj,
    slippage: 0.01,
  };

  try {
    // Step 1: Get a fresh quotation
    let quotation;
    switch (source) {
      case 'paraswap-v5':
      case 'paraswapv5': {
        // Normalize source name
        const normalizedSource = source === 'paraswapv5' ? 'paraswap-v5' : source;
        quotation = await withRetry(
          () => api.protocols.paraswapv5.getSwapTokenQuotation(chainId, params),
          {
            label: `fresh-quote.${normalizedSource}.${tokenIn.symbol}->${tokenOut.symbol}`,
            shouldRetry: (err: any) => {
              if (err?.response?.status === 400) return false;
              return isTransientError(err);
            },
            retries: 2,
          }
        );
        break;
      }
      case 'openoceanv2': {
        // OpenOcean is NOT supported for execution on Polygon
        // Fallback to ParaSwap V5
        log.warn(`OpenOcean V2 not supported for execution on Polygon, falling back to ParaSwap V5`);
        const fallbackParams = {
          input: { token: tokenInObj, amount: amountIn },
          tokenOut: tokenOutObj,
          slippage: 0.01,
        };
        quotation = await withRetry(
          () => api.protocols.paraswapv5.getSwapTokenQuotation(chainId, fallbackParams),
          {
            label: `fallback.paraswap-v5.${tokenIn.symbol}->${tokenOut.symbol}`,
            shouldRetry: (err: any) => {
              if (err?.response?.status === 400) return false;
              return isTransientError(err);
            },
            retries: 2,
          }
        );
        break;
      }
      default:
        // Unknown source, fallback to ParaSwap
        log.warn(`Unknown source ${source}, falling back to ParaSwap V5`);
        const fallbackParams2 = {
          input: { token: tokenInObj, amount: amountIn },
          tokenOut: tokenOutObj,
          slippage: 0.01,
        };
        quotation = await withRetry(
          () => api.protocols.paraswapv5.getSwapTokenQuotation(chainId, fallbackParams2),
          {
            label: `fallback.paraswap-v5.${tokenIn.symbol}->${tokenOut.symbol}`,
            shouldRetry: (err: any) => {
              if (err?.response?.status === 400) return false;
              return isTransientError(err);
            },
            retries: 2,
          }
        );
    }

    if (!quotation) {
      log.warn(`Fresh quotation returned null for ${source}`, {
        tokenIn: tokenIn.symbol,
        tokenOut: tokenOut.symbol,
      });
      return null;
    }

    // Step 2: Re-check profitability against the scanner's estimate
    const freshAmountOut = Number(quotation.amountOut) / 10 ** tokenOut.decimals;
    const originalAmountOut = Number(opp.spreadOpp.sellQuote.amountOut) / 10 ** tokenOut.decimals;

    if (freshAmountOut < originalAmountOut * 0.9) {
      // Fresh quote is worse by >10% — skip to avoid losing trade
      log.warn(`Fresh quote significantly worse than scanner estimate (${source})`, {
        tokenIn: tokenIn.symbol,
        tokenOut: tokenOut.symbol,
        originalAmountOut,
        freshAmountOut,
        dropPercent: ((originalAmountOut - freshAmountOut) / originalAmountOut * 100).toFixed(2) + '%',
      });
      return null;
    }

    // Step 3: Build logic from quotation
    switch (source) {
      case 'paraswap-v5':
      case 'paraswapv5': {
        return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
      }
      case 'openoceanv2': {
        // If we fell back to ParaSwap, use its logic builder
        // If OpenOcean is truly supported, use its builder
        // For now, fallback to ParaSwap
        log.warn(`Using ParaSwap logic for OpenOcean quote (fallback)`);
        return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
      }
      default: {
        // Try ParaSwap as fallback
        log.warn(`Unknown source ${source}, using ParaSwap logic builder`);
        return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
      }
    }
  } catch (err) {
    const error = err as any;
    const statusCode = error?.response?.status;
    const responseData = error?.response?.data;

    log.error(`Swap logic build failed (${source}) — DETAILED:`, {
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      tokenInAddress: tokenIn.address,
      tokenOutAddress: tokenOut.address,
      amountIn,
      statusCode,
      responseData: typeof responseData === 'string' ? responseData : JSON.stringify(responseData ?? {}),
      errorMessage: error?.message || String(err),
    });
    return null;
  }
}