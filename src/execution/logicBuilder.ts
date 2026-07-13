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

/**
 * Builds the ordered logic array for a single arbitrage round-trip:
 * 1. Aave V3 flashloan of the base position size
 * 2. Swap on whichever source the scanner found the best buy price on
 * 3. Swap on whichever source the scanner found the best sell price on
 *
 * Critically, this dispatches per-leg to the actual source the evaluator
 * picked (uniswapv3 / paraswapv5 / openoceanv2 / balancerv2) rather than
 * hardcoding ParaSwap for both legs. If ParaSwap genuinely has no route
 * for a pair at the current size, forcing it anyway just fails — using
 * the source the scanner already confirmed has a live quote is the fix.
 */
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

  // 2. Buy-side swap: quote token -> base token, on the source the
  // scanner identified as offering the best (lowest) buy price.
  const buySource = opp.spreadOpp.buySource;
  const buyLogic = await buildSwapLogic(
    buySource,
    opp.pair.quote,
    opp.pair.base,
    flashLoanAmountRaw
  );
  if (!buyLogic) {
    throw new Error(`Failed to build buy swap logic for source ${buySource}`);
  }
  logics.push(buyLogic);

  // 3. Sell-side swap: base token -> quote token, on the source the
  // scanner identified as offering the best (highest) sell price.
  // Uses the buy-side output amount rather than a fixed figure, since
  // the exact base-token amount received depends on the buy leg's
  // actual execution, not the pre-trade estimate.
  const sellSource = opp.spreadOpp.sellSource;
  const buyOutputAmount = opp.spreadOpp.buyQuote.amountOut;
  const sellLogic = await buildSwapLogic(
    sellSource,
    opp.pair.base,
    opp.pair.quote,
    buyOutputAmount
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
 * Dispatches swap-logic building to the correct Protocolink protocol
 * module based on the source string the scanner/evaluator determined
 * had the winning quote. Each protocol's getSwapTokenQuotation has a
 * slightly different accepted params shape per Protocolink's docs, so
 * each branch builds its own params object rather than sharing one
 * generic shape across all four.
 */
async function buildSwapLogic(
  source: string,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string
): Promise<any | null> {
  const chainId = getChainId();
  const tokenInObj = toProtocolinkToken(chainId, tokenIn);
  const tokenOutObj = toProtocolinkToken(chainId, tokenOut);

  if (!amountIn || amountIn === '0') {
    log.warn('Swap amount is zero or invalid, skipping', {
      source,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amountIn,
    });
    return null;
  }

  try {
    switch (source) {
      case 'uniswapv3': {
        const quotation = await withRetry(
          () =>
            api.protocols.uniswapv3.getSwapTokenQuotation(chainId, {
              input: { token: tokenInObj, amount: amountIn },
              tokenOut: tokenOutObj,
            }),
          {
            label: `uniswapv3.${tokenIn.symbol}->${tokenOut.symbol}`,
            shouldRetry: (err: any) => (err?.response?.status === 400 ? false : isTransientError(err)),
            retries: 2,
          }
        );
        return api.protocols.uniswapv3.newSwapTokenLogic(quotation);
      }

      case 'paraswapv5': {
        const quotation = await withRetry(
          () =>
            api.protocols.paraswapv5.getSwapTokenQuotation(chainId, {
              input: { token: tokenInObj, amount: amountIn },
              tokenOut: tokenOutObj,
            }),
          {
            label: `paraswapv5.${tokenIn.symbol}->${tokenOut.symbol}`,
            shouldRetry: (err: any) => (err?.response?.status === 400 ? false : isTransientError(err)),
            retries: 2,
          }
        );
        return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
      }

      case 'openoceanv2': {
        const quotation = await withRetry(
          () =>
            api.protocols.openoceanv2.getSwapTokenQuotation(chainId, {
              input: { token: tokenInObj, amount: amountIn },
              tokenOut: tokenOutObj,
            }),
          {
            label: `openoceanv2.${tokenIn.symbol}->${tokenOut.symbol}`,
            shouldRetry: (err: any) => (err?.response?.status === 400 ? false : isTransientError(err)),
            retries: 2,
          }
        );
        return api.protocols.openoceanv2.newSwapTokenLogic(quotation);
      }

      case 'balancerv2': {
        const quotation = await withRetry(
          () =>
            api.protocols.balancerv2.getSwapTokenQuotation(chainId, {
              input: { token: tokenInObj, amount: amountIn },
              tokenOut: tokenOutObj,
            }),
          {
            label: `balancerv2.${tokenIn.symbol}->${tokenOut.symbol}`,
            shouldRetry: (err: any) => (err?.response?.status === 400 ? false : isTransientError(err)),
            retries: 2,
          }
        );
        return api.protocols.balancerv2.newSwapTokenLogic(quotation);
      }

      default:
        log.warn('Unsupported swap source requested', { source });
        return null;
    }
  } catch (err) {
    const error = err as any;
    const statusCode = error?.response?.status;
    const responseData = error?.response?.data;

    log.error('Swap logic build failed', {
      source,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      tokenInAddress: tokenIn.address,
      tokenOutAddress: tokenOut.address,
      amountIn,
      statusCode,
      response: typeof responseData === 'string' ? responseData : JSON.stringify(responseData ?? {}),
      error: error?.message || String(err),
    });
    return null;
  }
}