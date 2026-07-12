import * as api from '@protocolink/api';
import { TokenInfo } from '../config/tokens';
import { EvaluatedOpportunity } from '../profitability/evaluator';
import { getChainId } from './protocolinkClient';
import { createLogger } from '../utils/logger';

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

  // Flash loan logic (Aave V3)
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

  // Buy-side swap
  let buySource = opp.spreadOpp.buySource;
  let buySwapLogic = await buildSwapLogicWithFallback(
    buySource,
    opp.pair.quote,
    opp.pair.base,
    flashLoanAmountRaw
  );

  if (!buySwapLogic) {
    throw new Error(`Failed to build buy-side swap logic for source ${buySource}`);
  }
  logics.push(buySwapLogic);

  // Sell-side swap (amount is auto, but we need to get the output amount from previous logic)
  // In Protocolink, the output of the first swap is the input of the second if we chain them.
  // For simplicity, we assume the amount is `auto` and the SDK handles it.
  // However, we need to pass `auto` as a string.
  const sellAmount = 'auto';
  let sellSource = opp.spreadOpp.sellSource;
  let sellSwapLogic = await buildSwapLogicWithFallback(
    sellSource,
    opp.pair.base,
    opp.pair.quote,
    sellAmount
  );

  if (!sellSwapLogic) {
    throw new Error(`Failed to build sell-side swap logic for source ${sellSource}`);
  }
  logics.push(sellSwapLogic);

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
 * Attempts to build swap logic for a given source. If the source fails,
 * it falls back to OpenOcean (if available) and then to Uniswap V3.
 */
async function buildSwapLogicWithFallback(
  source: string,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string
): Promise<any | null> {
  const chainId = getChainId();

  // Try the requested source first
  let swapLogic = await buildSwapLogicSingle(source, tokenIn, tokenOut, amountIn);
  if (swapLogic) return swapLogic;

  // Fallback to OpenOcean
  if (source !== 'openoceanv2') {
    log.info(`Falling back to OpenOcean for swap (${tokenIn.symbol}->${tokenOut.symbol})`);
    swapLogic = await buildSwapLogicSingle('openoceanv2', tokenIn, tokenOut, amountIn);
    if (swapLogic) return swapLogic;
  }

  // Fallback to Uniswap V3
  if (source !== 'uniswapv3') {
    log.info(`Falling back to Uniswap V3 for swap (${tokenIn.symbol}->${tokenOut.symbol})`);
    swapLogic = await buildSwapLogicSingle('uniswapv3', tokenIn, tokenOut, amountIn);
    if (swapLogic) return swapLogic;
  }

  log.warn('All swap sources failed', { tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol, source });
  return null;
}

async function buildSwapLogicSingle(
  source: string,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string
): Promise<any | null> {
  const chainId = getChainId();

  const tokenInObj = { chainId, address: tokenIn.address, decimals: tokenIn.decimals, symbol: tokenIn.symbol, name: tokenIn.name };
  const tokenOutObj = { chainId, address: tokenOut.address, decimals: tokenOut.decimals, symbol: tokenOut.symbol, name: tokenOut.name };

  try {
    switch (source) {
      case 'uniswapv3': {
        const quotation = await api.protocols.uniswapv3.getSwapTokenQuotation(chainId, {
          input: { token: tokenInObj, amount: amountIn },
          tokenOut: tokenOutObj,
        });
        return api.protocols.uniswapv3.newSwapTokenLogic(quotation);
      }
      case 'paraswapv5': {
        const quotation = await api.protocols.paraswapv5.getSwapTokenQuotation(chainId, {
          input: { token: tokenInObj, amount: amountIn },
          tokenOut: tokenOutObj,
        });
        return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
      }
      case 'openoceanv2': {
        const quotation = await api.protocols.openoceanv2.getSwapTokenQuotation(chainId, {
          input: { token: tokenInObj, amount: amountIn },
          tokenOut: tokenOutObj,
        });
        return api.protocols.openoceanv2.newSwapTokenLogic(quotation);
      }
      default:
        log.warn('Unsupported swap source requested', { source });
        return null;
    }
  } catch (err) {
    log.warn('Swap logic build failed', {
      source,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}