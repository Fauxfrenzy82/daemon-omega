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

  const flashLoanLogic = await api.protocols.aavev3.newFlashLoanLogic({
    id: 'aave-v3-flashloan',
    isLoan: true,
    loans: [{
      token: toProtocolinkToken(chainId, flashLoanToken),
      amount: flashLoanAmountRaw,
    }],
  });
  logics.push(flashLoanLogic);

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
  if (!buyLogic) throw new Error(`Failed to build buy swap logic for source ${buySource}`);
  logics.push(buyLogic);

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
  if (!sellLogic) throw new Error(`Failed to build sell swap logic for source ${sellSource}`);
  logics.push(sellLogic);

  log.info('Built arbitrage logic sequence', {
    pairId: opp.pair.id,
    buySource: buyRequiresRequote ? `${buySource}→requoted` : buySource,
    sellSource: sellRequiresRequote ? `${sellSource}→requoted` : sellSource,
  });

  return { logics, flashLoanAmount: flashLoanAmountRaw, flashLoanToken };
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

  if (!amountIn || amountIn === '0') {
    log.warn('Swap amount is zero', { source, tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol });
    return null;
  }

  // For non-executable sources, try KyberSwap as fallback, then QuickSwap
  if (requiresRequote) {
    log.info(`🔄 Re-quoting ${source} → kyberswap (${tokenIn.symbol}→${tokenOut.symbol})`);
    // Try KyberSwap first
    try {
      const kyberQuote = await api.protocols.kyberswap.getSwapTokenQuotation(chainId, {
        input: { token: tokenInObj, amount: amountIn },
        tokenOut: tokenOutObj,
      });
      return api.protocols.kyberswap.newSwapTokenLogic(kyberQuote);
    } catch (err) {
      log.warn('KyberSwap fallback failed, trying QuickSwap', { error: String(err) });
    }
    // Then QuickSwap
    try {
      const quickQuote = await api.protocols.quickswap.getSwapTokenQuotation(chainId, {
        input: { token: tokenInObj, amount: amountIn },
        tokenOut: tokenOutObj,
      });
      return api.protocols.quickswap.newSwapTokenLogic(quickQuote);
    } catch (err) {
      log.warn('QuickSwap fallback failed', { error: String(err) });
      return null;
    }
  }

  // Direct execution for supported sources
  try {
    switch (source) {
      case 'quickswap':
      case 'quickswap-v3': {
        const quote = await api.protocols.quickswap.getSwapTokenQuotation(chainId, {
          input: { token: tokenInObj, amount: amountIn },
          tokenOut: tokenOutObj,
        });
        return api.protocols.quickswap.newSwapTokenLogic(quote);
      }
      case 'balancerv2':
      case 'balancer-v2': {
        const quote = await api.protocols.balancerv2.getSwapTokenQuotation(chainId, {
          input: { token: tokenInObj, amount: amountIn },
          tokenOut: tokenOutObj,
        });
        return api.protocols.balancerv2.newSwapTokenLogic(quote);
      }
      case 'curve': {
        const quote = await api.protocols.curve.getSwapTokenQuotation(chainId, {
          input: { token: tokenInObj, amount: amountIn },
          tokenOut: tokenOutObj,
        });
        return api.protocols.curve.newSwapTokenLogic(quote);
      }
      case 'kyberswap':
      case 'kyber': {
        const quote = await api.protocols.kyberswap.getSwapTokenQuotation(chainId, {
          input: { token: tokenInObj, amount: amountIn },
          tokenOut: tokenOutObj,
        });
        return api.protocols.kyberswap.newSwapTokenLogic(quote);
      }
      default:
        log.error(`No execution builder for source: ${source}`);
        return null;
    }
  } catch (err) {
    const error = err as any;
    log.error(`Swap logic build failed (${source})`, {
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      error: error?.message || String(err),
    });
    return null;
  }
}