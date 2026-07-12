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

/**
 * Builds the arbitrage logic sequence with fresh quotes at execution time.
 * This avoids the scanner/execution mismatch and handles fallback sources.
 */
export async function buildArbitrageLogics(
  opp: EvaluatedOpportunity,
  flashLoanToken: TokenInfo,
  flashLoanAmountRaw: string
): Promise<BuiltLogics> {
  const chainId = getChainId();
  const logics: any[] = [];

  // 1. Flash loan logic (Aave V3)
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

  // 2. Buy-side swap: quote -> base (using the flash loan amount)
  const buySource = opp.spreadOpp.buySource;
  const buyLogic = await buildSwapLogicWithFreshQuote(
    buySource,
    opp.pair.quote,
    opp.pair.base,
    flashLoanAmountRaw
  );
  if (!buyLogic) {
    throw new Error(`Failed to build buy swap logic for source ${buySource}`);
  }
  logics.push(buyLogic);

  // 3. Sell-side swap: base -> quote
  // We need to estimate the amount of base we'll have after the buy swap.
  // We'll fetch a fresh quote for the sell side using the same amount (or a reasonable estimate).
  // For simplicity, we use the raw amount of the buy side, but in base token units.
  // However, we don't know the exact amount of base we'll get. To avoid guesswork,
  // we use Protocolink's chaining by setting amountIn to 'auto'.
  // Some sources (like ParaSwap) may not support 'auto', so we fallback to a fixed amount.
  const sellSource = opp.spreadOpp.sellSource;
  let sellLogic;

  // Try to build with 'auto' first (preferred for chaining)
  try {
    sellLogic = await buildSwapLogicWithFreshQuote(
      sellSource,
      opp.pair.base,
      opp.pair.quote,
      'auto'
    );
  } catch (e) {
    log.warn('Failed to build sell swap with auto, falling back to fixed amount', { error: String(e) });
  }

  if (!sellLogic) {
    // Fallback: use the flash loan amount divided by the buy price to estimate base amount.
    const buyPrice = opp.spreadOpp.buyQuote.price;
    const estimatedBaseAmountWei = ethers.utils.parseUnits(
      (Number(flashLoanAmountRaw) / buyPrice).toFixed(opp.pair.base.decimals),
      opp.pair.base.decimals
    );
    const estimatedBaseAmount = estimatedBaseAmountWei.toString();
    log.info('Using estimated base amount for sell swap', { estimatedBaseAmount });
    sellLogic = await buildSwapLogicWithFreshQuote(
      sellSource,
      opp.pair.base,
      opp.pair.quote,
      estimatedBaseAmount
    );
  }

  if (!sellLogic) {
    throw new Error(`Failed to build sell swap logic for source ${sellSource}`);
  }
  logics.push(sellLogic);

  return {
    logics,
    flashLoanAmount: flashLoanAmountRaw,
    flashLoanToken,
  };
}

/**
 * Builds a swap logic for a single source, with fallback to other sources if the primary fails.
 */
async function buildSwapLogicWithFreshQuote(
  source: string,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string
): Promise<any | null> {
  const chainId = getChainId();

  const tokenInObj = { chainId, address: tokenIn.address, decimals: tokenIn.decimals, symbol: tokenIn.symbol, name: tokenIn.name };
  const tokenOutObj = { chainId, address: tokenOut.address, decimals: tokenOut.decimals, symbol: tokenOut.symbol, name: tokenOut.name };

  // Try the requested source first
  let logic = await buildSwapLogicForSource(source, tokenInObj, tokenOutObj, amountIn);
  if (logic) return logic;

  // Fallback to OpenOcean
  if (source !== 'openoceanv2') {
    log.info(`Falling back to OpenOcean for swap (${tokenIn.symbol}->${tokenOut.symbol})`);
    logic = await buildSwapLogicForSource('openoceanv2', tokenInObj, tokenOutObj, amountIn);
    if (logic) return logic;
  }

  // Fallback to Uniswap V3
  if (source !== 'uniswapv3') {
    log.info(`Falling back to Uniswap V3 for swap (${tokenIn.symbol}->${tokenOut.symbol})`);
    logic = await buildSwapLogicForSource('uniswapv3', tokenInObj, tokenOutObj, amountIn);
    if (logic) return logic;
  }

  log.warn('All swap sources failed', { tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol, source });
  return null;
}

async function buildSwapLogicForSource(
  source: string,
  tokenIn: any,
  tokenOut: any,
  amountIn: string
): Promise<any | null> {
  try {
    let quotation;
    const chainId = tokenIn.chainId;

    switch (source) {
      case 'uniswapv3': {
        quotation = await api.protocols.uniswapv3.getSwapTokenQuotation(chainId, {
          input: { token: tokenIn, amount: amountIn },
          tokenOut: tokenOut,
        });
        return api.protocols.uniswapv3.newSwapTokenLogic(quotation);
      }
      case 'paraswapv5': {
        quotation = await api.protocols.paraswapv5.getSwapTokenQuotation(chainId, {
          input: { token: tokenIn, amount: amountIn },
          tokenOut: tokenOut,
        });
        return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
      }
      case 'openoceanv2': {
        quotation = await api.protocols.openoceanv2.getSwapTokenQuotation(chainId, {
          input: { token: tokenIn, amount: amountIn },
          tokenOut: tokenOut,
        });
        return api.protocols.openoceanv2.newSwapTokenLogic(quotation);
      }
      default:
        log.warn('Unsupported swap source', { source });
        return null;
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.warn('Swap source failed', { source, error: errorMsg });
    return null;
  }
}