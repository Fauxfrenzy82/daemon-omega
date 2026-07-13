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
    if (source === 'uniswapv3') {
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

    if (source === 'openoceanv2') {
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

    log.warn('Unsupported or unavailable swap source requested', { source });
    return null;
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