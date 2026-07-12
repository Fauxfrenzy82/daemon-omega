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

  // FIX: Added `id` and `isLoan` as required by the current Protocolink API.
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

  const buySwapLogic = await buildSwapLogic(
    opp.spreadOpp.buySource,
    opp.pair.quote,
    opp.pair.base,
    flashLoanAmountRaw
  );

  if (!buySwapLogic) {
    throw new Error(`Failed to build buy-side swap logic for source ${opp.spreadOpp.buySource}`);
  }
  logics.push(buySwapLogic);

  const sellSwapLogic = await buildSwapLogic(
    opp.spreadOpp.sellSource,
    opp.pair.base,
    opp.pair.quote,
    'auto'
  );

  if (!sellSwapLogic) {
    throw new Error(`Failed to build sell-side swap logic for source ${opp.spreadOpp.sellSource}`);
  }
  logics.push(sellSwapLogic);

  log.info('Built arbitrage logic sequence', {
    pairId: opp.pair.id,
    buySource: opp.spreadOpp.buySource,
    sellSource: opp.spreadOpp.sellSource,
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
      // Balancer V2 removed because its API no longer supports getSwapTokenQuotation/newSwapTokenLogic in this version.
      default:
        log.warn('Unsupported swap source requested', { source });
        return null;
    }
  } catch (err) {
    log.error('Swap logic build failed', {
      source,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}