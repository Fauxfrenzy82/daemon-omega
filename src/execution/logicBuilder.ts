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

  // 3. Sell-side swap: base token -> quote token
  const buyOutputAmount = opp.spreadOpp.buyQuote.amountOut;
  const sellSource = opp.spreadOpp.sellSource;

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
 * Builds swap logic for a single source using Protocolink's correct flow:
 * 1. getSwapTokenQuotation() → quotation object
 * 2. newSwapTokenLogic(quotation) → logic object
 *
 * Currently only ParaSwap V5 is supported because Protocolink does not support
 * OpenOcean V2 on Polygon, and Uniswap V3/Balancer V2 have address/API issues.
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

  // Normalize source to Protocolink's official identifier
  const normalizedSource = source === 'paraswapv5' ? 'paraswap-v5' : source;

  // Only ParaSwap V5 is supported in this version
  if (normalizedSource !== 'paraswap-v5') {
    log.warn('Unsupported swap source, falling back to paraswap-v5', {
      requested: normalizedSource,
    });
  }

  const params = {
    input: { token: tokenInObj, amount: amountIn },
    tokenOut: tokenOutObj,
    slippage: 0.01, // 1% slippage tolerance to avoid "price impact too high" errors
  };

  log.debug('Building ParaSwap V5 swap logic', {
    tokenIn: tokenIn.symbol,
    tokenOut: tokenOut.symbol,
    amountIn,
    slippage: params.slippage,
  });

  try {
    // Step 1: Get quotation from ParaSwap V5
    const quotation = await withRetry(
      () => api.protocols.paraswapv5.getSwapTokenQuotation(chainId, params),
      {
        label: `paraswap-v5.${tokenIn.symbol}->${tokenOut.symbol}`,
        shouldRetry: (err: any) => {
          // Don't retry on 400 (bad request) — it won't succeed
          if (err?.response?.status === 400) return false;
          return isTransientError(err);
        },
        retries: 2,
      }
    );

    // Step 2: Build logic from quotation
    return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
  } catch (err) {
    const error = err as any;
    const statusCode = error?.response?.status;
    const responseData = error?.response?.data;

    log.error('ParaSwap V5 swap logic build failed — DETAILED:', {
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