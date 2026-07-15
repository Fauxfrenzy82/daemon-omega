import * as api from '@protocolink/api';
import { TokenInfo } from '../config/tokens';
import { EvaluatedOpportunity } from '../profitability/evaluator';
import { getChainId } from './protocolinkClient';
import { createLogger } from '../utils/logger';
import { withRetry, isTransientError } from '../utils/retry';
import { env } from '../config/env';
import { deepInspect, logTokenEssentials } from '../utils/diagnostics';

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

// Cache each provider's flash-loan token list per process lifetime.
const flashLoanTokenListCache: Record<string, any[] | null> = {
  'Aave V3': null,
  'Balancer V2': null,
};

async function getMatchedFlashLoanToken(
  providerName: 'Aave V3' | 'Balancer V2',
  chainId: number,
  token: TokenInfo
): Promise<any | null> {
  if (!flashLoanTokenListCache[providerName]) {
    try {
      flashLoanTokenListCache[providerName] =
        providerName === 'Aave V3'
          ? await api.protocols.aavev3.getFlashLoanTokenList(chainId)
          : await api.protocols.balancerv2.getFlashLoanTokenList(chainId);
      log.info(`📋 Fetched ${providerName} flash loan token list`, {
        count: flashLoanTokenListCache[providerName]?.length || 0,
      });
    } catch (err: any) {
      log.warn(`Failed to fetch ${providerName} flash loan token list`, {
        error: err instanceof Error ? err.message : String(err),
        stack: err?.stack,
      });
      return null;
    }
  }

  const matched = flashLoanTokenListCache[providerName]?.find(
    (t: any) => t.address.toLowerCase() === token.address.toLowerCase()
  );

  if (!matched) {
    log.debug(`Token ${token.symbol} not found in ${providerName} flash loan list`);
    return null;
  }

  logTokenEssentials(matched, `MatchedToken-${providerName}`);
  return matched;
}

// Priority: Aave V3 first, then Balancer V2
const FLASH_LOAN_PROVIDERS: Array<{
  name: 'Aave V3' | 'Balancer V2';
  getLogic: (loans: any[]) => any;
}> = [
  { name: 'Aave V3', getLogic: (loans: any[]) => api.protocols.aavev3?.newFlashLoanLogicPair?.(loans) },
  { name: 'Balancer V2', getLogic: (loans: any[]) => api.protocols.balancerv2?.newFlashLoanLogicPair?.(loans) },
];

export async function buildArbitrageLogics(
  opp: EvaluatedOpportunity,
  flashLoanToken: TokenInfo,
  flashLoanAmountRaw: string,
  options: RequoteOptions = {}
): Promise<BuiltLogics> {
  const chainId = getChainId();
  const logics: any[] = [];

  const humanAmount = Number(flashLoanAmountRaw) / (10 ** flashLoanToken.decimals);
  log.info('💡 Building Arbitrage Logics', {
    pair: opp.pair.id,
    flashLoanToken: flashLoanToken.symbol,
    flashLoanAmountRaw,
    humanAmount: humanAmount.toFixed(flashLoanToken.decimals > 6 ? 4 : 2),
    chainId,
    buySource: opp.spreadOpp.buySource,
    sellSource: opp.spreadOpp.sellSource,
  });

  let flashLoanLoanLogic: any;
  let flashLoanRepayLogic: any;
  let providerUsed = '';

  for (const provider of FLASH_LOAN_PROVIDERS) {
    try {
      if (!provider.getLogic) {
        log.debug(`Provider ${provider.name} not available, skipping`);
        continue;
      }

      const matchedToken = await getMatchedFlashLoanToken(provider.name, chainId, flashLoanToken);
      if (!matchedToken) {
        log.debug(`Skipping ${provider.name} — token not in its flash loan list`, {
          token: flashLoanToken.symbol,
        });
        continue;
      }

      const loans = [
        {
          token: matchedToken,
          amount: flashLoanAmountRaw,
        },
      ];

      log.info(`📤 Flash loan request to ${provider.name}`, {
        token: flashLoanToken.symbol,
        amount: flashLoanAmountRaw,
        humanAmount: humanAmount.toFixed(flashLoanToken.decimals > 6 ? 4 : 2),
      });

      const result = provider.getLogic(loans);
      if (!result || !Array.isArray(result) || result.length !== 2) {
        throw new Error(`Invalid result from ${provider.name}`);
      }
      [flashLoanLoanLogic, flashLoanRepayLogic] = result;
      providerUsed = provider.name;
      log.info(`✅ Using ${provider.name} flash loan provider`);
      break;
    } catch (err: any) {
      log.warn(`Failed to use ${provider.name} for flash loan, trying next`, {
        error: String(err),
      });
    }
  }

  if (!flashLoanLoanLogic || !flashLoanRepayLogic) {
    throw new Error('No flash loan provider available for the token');
  }

  log.info('FLASH LOAN LOGICS CREATED', {
    provider: providerUsed,
    loanLogicRid: flashLoanLoanLogic?.rid,
    repayLogicRid: flashLoanRepayLogic?.rid,
  });

  logics.push(flashLoanLoanLogic);

  // Buy swap: flashLoanToken -> base
  const buySource = opp.spreadOpp.buySource;
  const buyRequiresRequote = options.buyRequiresRequote || false;
  const buyResult = await buildSwapLogic(
    buySource,
    buyRequiresRequote,
    flashLoanToken,
    opp.pair.base,
    flashLoanAmountRaw,
    opp
  );
  if (!buyResult) {
    throw new Error(`Failed to build buy swap logic for source ${buySource}`);
  }
  logics.push(buyResult.logic);

  // Sell swap: base -> flashLoanToken
  const sellSource = opp.spreadOpp.sellSource;
  const sellRequiresRequote = options.sellRequiresRequote || false;
  const sellResult = await buildSwapLogic(
    sellSource,
    sellRequiresRequote,
    opp.pair.base,
    flashLoanToken,
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
    sellActualOutput: sellResult.actualOutputAmount,
    steps: logics.length,
    flashLoanProvider: providerUsed,
    flashLoanToken: flashLoanToken.symbol,
  });

  // Log only summary of final logics
  log.info('📦 FINAL LOGICS ARRAY', {
    count: logics.length,
    types: logics.map(l => l?.rid).filter(Boolean),
  });

  return {
    logics,
    flashLoanAmount: flashLoanAmountRaw,
    flashLoanToken,
  };
}

// buildSwapLogic with moderate logging
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

  const humanAmountIn = Number(amountIn) / (10 ** tokenIn.decimals);

  log.info('🔄 Building swap', {
    source,
    requiresRequote,
    tokenIn: tokenIn.symbol,
    tokenOut: tokenOut.symbol,
    amountIn,
    humanAmountIn: humanAmountIn.toFixed(tokenIn.decimals > 6 ? 4 : 2),
    chainId,
  });

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

  const params = {
    input: { token: tokenInObj, amount: amountIn },
    tokenOut: tokenOutObj,
    slippage: 100,
  };

  try {
    let quote: any;
    let logic: any;

    switch (executionSource) {
      case 'paraswap-v5':
      case 'paraswapv5': {
        quote = await withRetry(
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
        logic = api.protocols.paraswapv5.newSwapTokenLogic(quote);
        break;
      }

      case 'uniswap-v3':
      case 'uniswapv3': {
        quote = await withRetry(
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
        logic = api.protocols.uniswapv3.newSwapTokenLogic(quote);
        break;
      }

      case 'zeroex-v4':
      case 'zeroexv4': {
        const apiKey = env.ZEROEX_API_KEY || '';
        if (!apiKey) {
          log.warn('ZEROEX_API_KEY not set — falling back to ParaSwap for zeroex-v4');
          quote = await withRetry(
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
          logic = api.protocols.paraswapv5.newSwapTokenLogic(quote);
        } else {
          quote = await withRetry(
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
          logic = api.protocols.zeroexv4.newSwapTokenLogic(quote);
        }
        break;
      }

      default:
        log.error(`No execution builder available for source: ${source}`);
        return null;
    }

    log.info('📦 Swap logic created', {
      source: executionSource,
      actualOutputAmount: quote.output.amount,
    });

    return { logic, actualOutputAmount: quote.output.amount };
  } catch (err) {
    const error = err as any;
    const statusCode = error?.response?.status;
    const responseData = error?.response?.data;

    log.error(`❌ Swap logic build failed (${executionSource})`, {
      originalSource: source,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amountIn,
      statusCode,
      responseData: typeof responseData === 'string' ? responseData : JSON.stringify(responseData ?? {}),
      errorMessage: error?.message || String(err),
    });
    return null;
  }
}