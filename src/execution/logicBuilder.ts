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

  // 2. Buy-side swap: quote token -> base token
  // The scanner only uses ParaSwap V5 now, but we keep the source field for robustness
  const buySource = opp.spreadOpp.buySource;
  const buyLogic = await buildSwapLogicWithFallback(
    buySource,
    opp.pair.quote,
    opp.pair.base,
    flashLoanAmountRaw
  );
  if (!buyLogic) {
    throw new Error(`Failed to build buy swap logic for source ${buySource}`);
  }
  logics.push(buyLogic);

  // 3. Sell-side swap: base token -> quote token
  const buyOutputAmount = opp.spreadOpp.buyQuote.amountOut;
  const sellSource = opp.spreadOpp.sellSource;

  // Try the preferred sell source first, fallback to ParaSwap if needed
  let sellLogic = await buildSwapLogicWithFallback(
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
 * Builds swap logic for a given source, with fallback to ParaSwap V5.
 * Protocolink's ParaSwap V5 identifier is 'paraswap-v5' (with hyphen).
 */
async function buildSwapLogicWithFallback(
  source: string,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string
): Promise<any | null> {
  // Normalize source: if it's 'paraswapv5', convert to 'paraswap-v5'
  const normalizedSource = source === 'paraswapv5' ? 'paraswap-v5' : source;

  // Try the normalized source first
  let logic = await buildSwapLogic(normalizedSource, tokenIn, tokenOut, amountIn);
  if (logic) return logic;

  // If that fails, fallback to ParaSwap V5 (if it wasn't already tried)
  if (normalizedSource !== 'paraswap-v5') {
    log.warn(`Swap failed on source ${normalizedSource}, falling back to paraswap-v5`);
    logic = await buildSwapLogic('paraswap-v5', tokenIn, tokenOut, amountIn);
    if (logic) return logic;
  }

  return null;
}

/**
 * Builds swap logic for a single source using Protocolink's correct flow:
 * 1. getSwapTokenQuotation() → quotation object
 * 2. newSwapTokenLogic(quotation) → logic object
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
    log.warn('Swap amount is zero or invalid', {
      source,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amountIn,
    });
    return null;
  }

  const params = {
    input: { token: tokenInObj, amount: amountIn },
    tokenOut: tokenOutObj,
  };

  log.debug('Building swap logic', {
    source,
    tokenIn: tokenIn.symbol,
    tokenOut: tokenOut.symbol,
    amountIn,
    params: JSON.stringify(params, null, 2),
  });

  try {
    // Step 1: Get quotation
    let quotation;
    switch (source) {
      case 'paraswap-v5': {
        quotation = await withRetry(
          () => api.protocols.paraswapv5.getSwapTokenQuotation(chainId, params),
          {
            label: `paraswap-v5.${tokenIn.symbol}->${tokenOut.symbol}`,
            shouldRetry: (err: any) => (err?.response?.status === 400 ? false : isTransientError(err)),
            retries: 2,
          }
        );
        // Step 2: Build logic from quotation
        return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
      }
      case 'uniswapv3': {
        quotation = await withRetry(
          () => api.protocols.uniswapv3.getSwapTokenQuotation(chainId, params),
          {
            label: `uniswapv3.${tokenIn.symbol}->${tokenOut.symbol}`,
            shouldRetry: (err: any) => (err?.response?.status === 400 ? false : isTransientError(err)),
            retries: 2,
          }
        );
        return api.protocols.uniswapv3.newSwapTokenLogic(quotation);
      }
      case 'balancerv2': {
        quotation = await withRetry(
          () => api.protocols.balancerv2.getSwapTokenQuotation(chainId, params),
          {
            label: `balancerv2.${tokenIn.symbol}->${tokenOut.symbol}`,
            shouldRetry: (err: any) => (err?.response?.status === 400 ? false : isTransientError(err)),
            retries: 2,
          }
        );
        return api.protocols.balancerv2.newSwapTokenLogic(quotation);
      }
      default:
        log.warn('Unsupported swap source', { source });
        return null;
    }
  } catch (err) {
    const error = err as any;
    const statusCode = error?.response?.status;
    const responseData = error?.response?.data;

    log.error('Swap logic build failed — DETAILED:', {
      source,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amountIn,
      statusCode,
      responseData: typeof responseData === 'string' ? responseData : JSON.stringify(responseData ?? {}),
      errorMessage: error?.message || String(err),
    });
    return null;
  }
}