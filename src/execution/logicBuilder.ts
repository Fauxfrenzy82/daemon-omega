import * as api from '@protocolink/api';
import { TokenInfo } from '../config/tokens';
import { EvaluatedOpportunity } from '../profitability/evaluator';
import { getChainId } from './protocolinkClient';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';
import { env } from '../config/env';

const log = createLogger('logicBuilder');

export interface BuiltLogics {
  logics: any[];
  flashLoanAmount: string;
  flashLoanToken: TokenInfo;
}

export interface RequoteOptions {
  buyRequiresRequote?: boolean;
  sellRequiresRequote?: boolean;
}

interface SwapBuildResult {
  logic: any;
  actualOutputAmount: string;
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
  flashLoanAmountRaw: string,
  options: RequoteOptions = {}
): Promise<BuiltLogics> {
  const chainId = getChainId();
  const logics: any[] = [];

  // Flash loan using Balancer V2 (0% fee)
  const loans = [
    {
      token: toProtocolinkToken(chainId, flashLoanToken),
      amount: flashLoanAmountRaw,
    },
  ];

  log.info('FLASH LOAN INPUT (Balancer)', {
    chainId,
    flashLoanAmountRaw,
    flashLoanToken,
    protocolinkToken: toProtocolinkToken(chainId, flashLoanToken),
    loans: JSON.stringify(loans, null, 2),
  });

  // Use Balancer V2 flash loan logic (replaces Aave)
  const [flashLoanLoanLogic, flashLoanRepayLogic] = api.protocols['balancer-v2'].newFlashLoanLogicPair(loans);

  log.info('FLASH LOAN LOGICS CREATED (Balancer)', {
    loanLogic: JSON.stringify(flashLoanLoanLogic, null, 2),
    repayLogic: JSON.stringify(flashLoanRepayLogic, null, 2),
  });

  logics.push(flashLoanLoanLogic);

  // Buy-side swap
  const buySource = opp.spreadOpp.buySource;
  const buyRequiresRequote = options.buyRequiresRequote || false;
  const buyResult = await buildSwapLogic(
    buySource,
    buyRequiresRequote,
    opp.pair.quote,
    opp.pair.base,
    flashLoanAmountRaw,
    opp
  );
  if (!buyResult) {
    throw new Error(`Failed to build buy swap logic for source ${buySource}`);
  }
  logics.push(buyResult.logic);

  // Sell-side swap
  const sellSource = opp.spreadOpp.sellSource;
  const sellRequiresRequote = options.sellRequiresRequote || false;
  const sellResult = await buildSwapLogic(
    sellSource,
    sellRequiresRequote,
    opp.pair.base,
    opp.pair.quote,
    buyResult.actualOutputAmount,
    opp
  );
  if (!sellResult) {
    throw new Error(`Failed to build sell swap logic for source ${sellSource}`);
  }
  logics.push(sellResult.logic);

  // Repay logic must be LAST
  logics.push(flashLoanRepayLogic);

  log.info('Built arbitrage logic sequence', {
    pairId: opp.pair.id,
    buySource: buyRequiresRequote ? `${buySource}→requoted` : buySource,
    sellSource: sellRequiresRequote ? `${sellSource}→requoted` : sellSource,
    buyActualOutput: buyResult.actualOutputAmount,
    scanTimeEstimate: opp.spreadOpp.buyQuote.amountOut,
    steps: logics.length,
    flashLoanProvider: 'Balancer V2',
  });

  log.info('FINAL LOGICS ARRAY', {
    count: logics.length,
    flashLoanAmount: flashLoanAmountRaw,
    flashLoanToken: flashLoanToken.symbol,
    logics: JSON.stringify(logics, null, 2),
  });

  return {
    logics,
    flashLoanAmount: flashLoanAmountRaw,
    flashLoanToken,
  };
}

async function buildSwapLogic(
  source: string,
  requiresRequote: boolean,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string,
  opp: EvaluatedOpportunity
): Promise<SwapBuildResult | null> {
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

  const executionSource = requiresRequote ? 'paraswap-v5' : source;

  if (requiresRequote) {
    log.info(`🔄 Re-quoting ${source} → ${executionSource} (${tokenIn.symbol}→${tokenOut.symbol})`, {
      amountIn,
      positionSizeUsd: opp.positionSizeUsd,
    });
  }

  const params = {
    input: { token: tokenInObj, amount: amountIn },
    tokenOut: tokenOutObj,
    slippage: 100,
  };

  try {
    switch (executionSource) {
      case 'paraswap-v5':
      case 'paraswapv5': {
        const quote = await withRetry(
          () => api.protocols.paraswapv5.getSwapTokenQuotation(chainId, params),
          {
            label: `paraswap-v5.${tokenIn.symbol}->${tokenOut.symbol}`,
            shouldRetry: (err: any) => {
              if (err?.response?.status === 400) return false;
              return isTransientError(err);
            },
            retries: 2,
          }
        );

        log.info('SWAP QUOTE RECEIVED', {
          source: executionSource,
          tokenIn: tokenIn.symbol,
          tokenOut: tokenOut.symbol,
          amountIn,
          quote: JSON.stringify(quote, null, 2),
        });

        const logic = api.protocols.paraswapv5.newSwapTokenLogic(quote);

        log.info('SWAP LOGIC CREATED', {
          source: executionSource,
          actualOutputAmount: quote.output.amount,
          logic: JSON.stringify(logic, null, 2),
        });

        return { logic, actualOutputAmount: quote.output.amount };
      }

      case 'uniswap-v3':
      case 'uniswapv3': {
        const quote = await withRetry(
          () => api.protocols.uniswapv3.getSwapTokenQuotation(chainId, params),
          {
            label: `uniswap-v3.${tokenIn.symbol}->${tokenOut.symbol}`,
            shouldRetry: (err: any) => {
              if (err?.response?.status === 400) return false;
              return isTransientError(err);
            },
            retries: 2,
          }
        );

        log.info('SWAP QUOTE RECEIVED', {
          source: executionSource,
          tokenIn: tokenIn.symbol,
          tokenOut: tokenOut.symbol,
          amountIn,
          quote: JSON.stringify(quote, null, 2),
        });

        const logic = api.protocols.uniswapv3.newSwapTokenLogic(quote);

        log.info('SWAP LOGIC CREATED', {
          source: executionSource,
          actualOutputAmount: quote.output.amount,
          logic: JSON.stringify(logic, null, 2),
        });

        return { logic, actualOutputAmount: quote.output.amount };
      }

      case 'zeroex-v4':
      case 'zeroexv4': {
        const apiKey = env.ZEROEX_API_KEY || '';
        if (!apiKey) {
          log.warn('ZEROEX_API_KEY not set — falling back to ParaSwap for zeroex-v4');
          const fallbackQuote = await withRetry(
            () => api.protocols.paraswapv5.getSwapTokenQuotation(chainId, params),
            {
              label: `fallback.paraswap-v5.${tokenIn.symbol}->${tokenOut.symbol}`,
              shouldRetry: (err: any) => {
                if (err?.response?.status === 400) return false;
                return isTransientError(err);
              },
              retries: 2,
            }
          );

          log.info('SWAP QUOTE RECEIVED', {
            source: 'paraswap-v5 (fallback)',
            tokenIn: tokenIn.symbol,
            tokenOut: tokenOut.symbol,
            amountIn,
            quote: JSON.stringify(fallbackQuote, null, 2),
          });

          const logic = api.protocols.paraswapv5.newSwapTokenLogic(fallbackQuote);

          log.info('SWAP LOGIC CREATED', {
            source: 'paraswap-v5 (fallback)',
            actualOutputAmount: fallbackQuote.output.amount,
            logic: JSON.stringify(logic, null, 2),
          });

          return { logic, actualOutputAmount: fallbackQuote.output.amount };
        }

        const quote = await withRetry(
          () => api.protocols.zeroexv4.getSwapTokenQuotation(chainId, {
            ...params,
            apiKey,
          }),
          {
            label: `zeroex-v4.${tokenIn.symbol}->${tokenOut.symbol}`,
            shouldRetry: (err: any) => {
              if (err?.response?.status === 400) return false;
              return isTransientError(err);
            },
            retries: 2,
          }
        );

        log.info('SWAP QUOTE RECEIVED', {
          source: executionSource,
          tokenIn: tokenIn.symbol,
          tokenOut: tokenOut.symbol,
          amountIn,
          quote: JSON.stringify(quote, null, 2),
        });

        const logic = api.protocols.zeroexv4.newSwapTokenLogic(quote);

        log.info('SWAP LOGIC CREATED', {
          source: executionSource,
          actualOutputAmount: quote.output.amount,
          logic: JSON.stringify(logic, null, 2),
        });

        return { logic, actualOutputAmount: quote.output.amount };
      }

      default:
        log.error(`No execution builder available for source: ${source}`);
        return null;
    }
  } catch (err) {
    const error = err as any;
    const statusCode = error?.response?.status;
    const responseData = error?.response?.data;

    log.error(`Swap logic build failed (${executionSource}) — DETAILED:`, {
      originalSource: source,
      requiresRequote,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      tokenInAddress: tokenIn.address,
      tokenOutAddress: tokenOut.address,
      amountIn,
      statusCode,
      responseData: typeof responseData === 'string' ? responseData : JSON.stringify(responseData ?? {}),
      errorMessage: error?.message || String(err),
      stack: error?.stack,
      headers: error?.response?.headers,
      config: error?.config,
      request: error?.request,
      fullError: JSON.stringify(error, Object.getOwnPropertyNames(error)),
    });
    return null;
  }
}