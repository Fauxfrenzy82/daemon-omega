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

  // 1. Flash loan
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

  // 2. Buy-side swap: Use the scanner's buy source
  const buySource = opp.spreadOpp.buySource;
  const buyLogic = await buildSwapLogicForSource(
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

  // 3. Sell-side swap: Use the scanner's sell source
  const sellSource = opp.spreadOpp.sellSource;
  const buyOutputAmount = opp.spreadOpp.buyQuote.amountOut;
  const sellLogic = await buildSwapLogicForSource(
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
 * Builds swap logic for a specific source.
 * NO FALLBACK — if the source doesn't have an implementation, it fails.
 */
async function buildSwapLogicForSource(
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

  log.info(`🔄 Building swap logic for ${source} (${tokenIn.symbol}→${tokenOut.symbol})`, {
    amountIn,
    positionSizeUsd: opp.positionSizeUsd,
  });

  const params = {
    input: { token: tokenInObj, amount: amountIn },
    tokenOut: tokenOutObj,
    slippage: 0.01,
  };

  try {
    switch (source) {
      case 'paraswap-v5':
      case 'paraswapv5': {
        const normalizedSource = source === 'paraswapv5' ? 'paraswap-v5' : source;
        const quotation = await withRetry(
          () => api.protocols.paraswapv5.getSwapTokenQuotation(chainId, params),
          {
            label: `execution.${normalizedSource}.${tokenIn.symbol}->${tokenOut.symbol}`,
            shouldRetry: (err: any) => {
              if (err?.response?.status === 400) return false;
              return isTransientError(err);
            },
            retries: 2,
          }
        );
        return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
      }
      default:
        log.error(`No execution builder available for source: ${source}`);
        return null;
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