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

export async function buildArbitrageLogics(
  opp: EvaluatedOpportunity,
  flashLoanToken: TokenInfo,
  flashLoanAmountRaw: string
): Promise<BuiltLogics> {
  const chainId = getChainId();
  const logics: any[] = [];

  // 1. Flash loan logic
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

  // 2. Buy-side swap — use the scanner's buyQuote directly
  const buyQuote = opp.spreadOpp.buyQuote;
  const buyLogic = await buildSwapLogicFromQuote(buyQuote.source, buyQuote);
  if (!buyLogic) {
    throw new Error(`Failed to build buy swap logic for source ${buyQuote.source}`);
  }
  logics.push(buyLogic);

  // 3. Sell-side swap — use the scanner's sellQuote directly
  const sellQuote = opp.spreadOpp.sellQuote;
  const sellLogic = await buildSwapLogicFromQuote(sellQuote.source, sellQuote);
  if (!sellLogic) {
    throw new Error(`Failed to build sell swap logic for source ${sellQuote.source}`);
  }
  logics.push(sellLogic);

  log.info('Built arbitrage logic sequence', {
    pairId: opp.pair.id,
    buySource: buyQuote.source,
    sellSource: sellQuote.source,
    steps: logics.length,
  });

  return {
    logics,
    flashLoanAmount: flashLoanAmountRaw,
    flashLoanToken,
  };
}

async function buildSwapLogicFromQuote(source: string, quote: any): Promise<any | null> {
  const chainId = getChainId();
  const tokenIn = quote.tokenIn;
  const tokenOut = quote.tokenOut;
  const amountIn = quote.amountIn;

  try {
    switch (source) {
      case 'paraswapv5': {
        const quotation = await withRetry(
          () => api.protocols.paraswapv5.getSwapTokenQuotation(chainId, {
            input: { token: tokenIn, amount: amountIn },
            tokenOut: tokenOut,
          }),
          { label: `paraswapv5.${tokenIn.symbol}->${tokenOut.symbol}`, shouldRetry: isTransientError, retries: 2 }
        );
        return api.protocols.paraswapv5.newSwapTokenLogic(quotation);
      }
      case 'openoceanv2': {
        const quotation = await withRetry(
          () => api.protocols.openoceanv2.getSwapTokenQuotation(chainId, {
            input: { token: tokenIn, amount: amountIn },
            tokenOut: tokenOut,
          }),
          { label: `openoceanv2.${tokenIn.symbol}->${tokenOut.symbol}`, shouldRetry: isTransientError, retries: 2 }
        );
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