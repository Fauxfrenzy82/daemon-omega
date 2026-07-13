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

/**
 * Builds the ordered logic array for a single arbitrage round-trip:
 * 1. Aave V3 flashloan of the base position size
 * 2. Swap on whichever source the scanner found the best buy price on
 * 3. Swap on whichever source the scanner found the best sell price on
 *
 * ParaSwap V5 is intentionally not wired here. ParaSwap rebranded to
 * Velora and migrated infrastructure/contracts; every swap-logic-build
 * attempt against both the legacy apiv5.paraswap.io and api.paraswap.io
 * endpoints failed with "no route found" at a 100% rate, including on
 * trivial, deeply liquid stablecoin pairs — proof the endpoint itself
 * is the problem, not a routing/liquidity condition this system can
 * work around. Only uniswapv3 and openoceanv2 are dispatched here.
 * Balancer V2 is also absent: Protocolink's SDK exposes only flash-loan
 * functions for Balancer V2, not a swap-token quotation/logic pair.
 */
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

/**
 * Dispatches swap-logic building to the correct Protocolink protocol
 * module. Only uniswapv3 and openoceanv2 are supported — the two
 * sources confirmed working in production logs. paraswapv5 and
 * balancerv2 both fall through to the default (unsupported) case.
 */
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
    switch (source) {
      case 'uniswapv3': {
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

      case 'openoceanv2': {
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

      default:
        log.warn('Unsupported or unavailable swap source requested', { source });
        return null;
    }
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
