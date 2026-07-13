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

  // Flash loan: Protocolink requires BOTH a loan logic entry AND a
  // matching repay logic entry — newFlashLoanLogicPair returns the
  // pair together. The repay entry must be the LAST item in the
  // logics array (after every swap/other logic), so the router can
  // validate that borrowed funds are settled at the end of the
  // transaction. Every "flash loan logic should have repay logic"
  // 400 was because this repay step never existed here — only the
  // loan half was ever built.
  const loans = [
    {
      token: toProtocolinkToken(chainId, flashLoanToken),
      amount: flashLoanAmountRaw,
    },
  ];
  const [flashLoanLoanLogic, flashLoanRepayLogic] = api.protocols.aavev3.newFlashLoanLogicPair(loans);
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

  // Sell-side swap — uses the buy leg's ACTUAL execution-time output
  // amount, not the stale scan-time estimate.
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

  // Repay logic goes LAST, after every other step, per Protocolink's
  // documented flashloan pattern.
  logics.push(flashLoanRepayLogic);

  log.info('Built arbitrage logic sequence', {
    pairId: opp.pair.id,
    buySource: buyRequiresRequote ? `${buySource}→requoted` : buySource,
    sellSource: sellRequiresRequote ? `${sellSource}→requoted` : sellSource,
    buyActualOutput: buyResult.actualOutputAmount,
    scanTimeEstimate: opp.spreadOpp.buyQuote.amountOut,
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
        const logic = api.protocols.paraswapv5.newSwapTokenLogic(quote);
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
        const logic = api.protocols.uniswapv3.newSwapTokenLogic(quote);
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
          const logic = api.protocols.paraswapv5.newSwapTokenLogic(fallbackQuote);
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
        const logic = api.protocols.zeroexv4.newSwapTokenLogic(quote);
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
    });
    return null;
  }
}