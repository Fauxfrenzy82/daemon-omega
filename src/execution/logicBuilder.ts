import * as api from '@protocolink/api';
import { ethers } from 'ethers';
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

export interface RequoteOptions {
  buyRequiresRequote?: boolean;
  sellRequiresRequote?: boolean;
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
  const buyRequiresRequote = options.buyRequiresRequote || false;
  const buyLogic = await buildSwapLogicWithRequote(
    buySource,
    buyRequiresRequote,
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
  const sellRequiresRequote = options.sellRequiresRequote || false;
  const buyOutputAmount = opp.spreadOpp.buyQuote.amountOut;
  const sellLogic = await buildSwapLogicWithRequote(
    sellSource,
    sellRequiresRequote,
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
    buySource: buyRequiresRequote ? `${buySource}→requoted` : buySource,
    sellSource: sellRequiresRequote ? `${sellSource}→requoted` : sellSource,
    steps: logics.length,
  });

  return {
    logics,
    flashLoanAmount: flashLoanAmountRaw,
    flashLoanToken,
  };
}

async function buildSwapLogicWithRequote(
  source: string,
  requiresRequote: boolean,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string,
  opp: EvaluatedOpportunity
): Promise<any | null> {
  const chainId = getChainId();
  const tokenInObj = toProtocolinkToken(chainId, tokenIn);
  const tokenOutObj = toProtocolinkToken(chainId, tokenOut);

  // Validate amount
  if (!amountIn || amountIn === '0') {
    log.warn('Swap amount is zero or invalid', {
      source,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amountIn,
    });
    return null;
  }

  // Determine the actual source to use for execution
  // If re-quote is needed, fallback to ParaSwap V5
  const executionSource = requiresRequote ? 'paraswap-v5' : source;

  if (requiresRequote) {
    log.info(`🔄 Re-quoting ${source} → ${executionSource} (${tokenIn.symbol}→${tokenOut.symbol})`, {
      amountIn,
      positionSizeUsd: opp.positionSizeUsd,
    });
  } else {
    log.debug(`Building swap logic for ${executionSource} (${tokenIn.symbol}→${tokenOut.symbol})`, {
      amountIn,
      positionSizeUsd: opp.positionSizeUsd,
    });
  }

  const params = {
    input: { token: tokenInObj, amount: amountIn },
    tokenOut: tokenOutObj,
    slippage: 0.01,
  };

  try {
    switch (executionSource) {
      case 'paraswap-v5':
      case 'paraswapv5': {
        const normalizedSource = executionSource === 'paraswapv5' ? 'paraswap-v5' : executionSource;
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
        log.info(`📊 Fresh quote from ${normalizedSource}: ${tokenIn.symbol}→${tokenOut.symbol} obtained`);
        return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
      }

      // ✅ SushiSwap Execution Builder
      case 'sushiswap':
      case 'sushi-swap': {
        // For direct DEX execution, we need to build a swap logic using Protocolink's SushiSwap integration.
        // Protocolink supports SushiSwap through its protocol modules.
        // We'll use the same flow: getQuote → buildLogic.

        // Note: Protocolink's SushiSwap integration may have a different method name.
        // The actual implementation depends on the @protocolink/api version.
        // If the methods below don't exist, we'll fallback to ParaSwap.
        let quotation;
        try {
          // Attempt to use Protocolink's SushiSwap protocol
          // The exact method names vary by SDK version — adjust as needed.
          const sushiProtocol = (api.protocols as any).sushiswap || (api.protocols as any).sushi;

          if (sushiProtocol && typeof sushiProtocol.getSwapTokenQuotation === 'function') {
            quotation = await withRetry(
              () => sushiProtocol.getSwapTokenQuotation(chainId, params),
              {
                label: `sushiswap.${tokenIn.symbol}->${tokenOut.symbol}`,
                shouldRetry: (err: any) => {
                  if (err?.response?.status === 400) return false;
                  return isTransientError(err);
                },
                retries: 2,
              }
            );
            return sushiProtocol.newSwapTokenLogic(quotation);
          } else {
            log.warn('SushiSwap protocol not available in SDK, falling back to ParaSwap V5');
            // Fallback to ParaSwap
            quotation = await withRetry(
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
            return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
          }
        } catch (err) {
          log.warn('SushiSwap execution failed, falling back to ParaSwap V5', {
            tokenIn: tokenIn.symbol,
            tokenOut: tokenOut.symbol,
            error: err instanceof Error ? err.message : String(err),
          });
          // Fallback to ParaSwap
          quotation = await withRetry(
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
          return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
        }
      }

      // ✅ QuickSwap Execution Builder
      case 'quickswap': {
        // Similar to SushiSwap — attempt to use Protocolink's QuickSwap integration,
        // or fallback to ParaSwap.
        let quotation;
        try {
          const quickProtocol = (api.protocols as any).quickswap;
          if (quickProtocol && typeof quickProtocol.getSwapTokenQuotation === 'function') {
            quotation = await withRetry(
              () => quickProtocol.getSwapTokenQuotation(chainId, params),
              {
                label: `quickswap.${tokenIn.symbol}->${tokenOut.symbol}`,
                shouldRetry: (err: any) => {
                  if (err?.response?.status === 400) return false;
                  return isTransientError(err);
                },
                retries: 2,
              }
            );
            return quickProtocol.newSwapTokenLogic(quotation);
          } else {
            log.warn('QuickSwap protocol not available in SDK, falling back to ParaSwap V5');
            quotation = await withRetry(
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
            return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
          }
        } catch (err) {
          log.warn('QuickSwap execution failed, falling back to ParaSwap V5', {
            tokenIn: tokenIn.symbol,
            tokenOut: tokenOut.symbol,
            error: err instanceof Error ? err.message : String(err),
          });
          quotation = await withRetry(
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
          return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
        }
      }

      case 'uniswapv3':
      case 'uniswap-v3': {
        // Uniswap V3 execution via Protocolink
        const quotation = await withRetry(
          () => api.protocols.uniswapv3.getSwapTokenQuotation(chainId, params),
          {
            label: `uniswapv3.${tokenIn.symbol}->${tokenOut.symbol}`,
            shouldRetry: (err: any) => {
              if (err?.response?.status === 400) return false;
              return isTransientError(err);
            },
            retries: 2,
          }
        );
        return api.protocols.uniswapv3.newSwapTokenLogic(quotation);
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