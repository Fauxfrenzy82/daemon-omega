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

// Cache each protocol's supported-token list per process lifetime —
// these lists don't change mid-run, and re-fetching on every trade
// attempt would add latency for no benefit.
const tokenListCache: Record<string, Set<string> | null> = {
  uniswapv3: null,
  openoceanv2: null,
};

async function getSupportedAddresses(source: 'uniswapv3' | 'openoceanv2'): Promise<Set<string> | null> {
  if (tokenListCache[source]) return tokenListCache[source];

  try {
    const chainId = getChainId();
    const list =
      source === 'uniswapv3'
        ? await api.protocols.uniswapv3.getSwapTokenTokenList(chainId)
        : await api.protocols.openoceanv2.getSwapTokenTokenList(chainId);

    const addresses = new Set(list.map((t: any) => t.address.toLowerCase()));
    tokenListCache[source] = addresses;
    log.info('Fetched supported token list', { source, count: addresses.size });
    return addresses;
  } catch (err) {
    // If the list fetch itself fails, don't block trading on it —
    // fall through and let the actual swap attempt surface any error.
    log.warn('Failed to fetch supported token list, skipping pre-check', {
      source,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function isPairSupported(
  source: 'uniswapv3' | 'openoceanv2',
  tokenIn: TokenInfo,
  tokenOut: TokenInfo
): Promise<boolean> {
  const supported = await getSupportedAddresses(source);
  if (!supported) return true; // unknown — don't block, let the real call decide

  const inOk = supported.has(tokenIn.address.toLowerCase());
  const outOk = supported.has(tokenOut.address.toLowerCase());

  if (!inOk || !outOk) {
    log.warn('Token pair not in protocol supported list, will fall back', {
      source,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      tokenInSupported: inOk,
      tokenOutSupported: outOk,
    });
  }

  return inOk && outOk;
}

/**
 * Builds the ordered logic array for a single arbitrage round-trip:
 * 1. Aave V3 flashloan of the base position size
 * 2. Swap on whichever source the scanner found the best buy price on
 * 3. Swap on whichever source the scanner found the best sell price on
 *
 * Before attempting either swap leg, checks the chosen source's actual
 * Protocolink-registered token list. If the pair isn't on that specific
 * protocol's supported list (this is a Protocolink-side allowlist, not
 * a liquidity check), it falls back to Uniswap V3 automatically rather
 * than failing the whole trade — this is what was causing OpenOcean's
 * "unsupported protocol logic" errors on WETH/WMATIC sell legs.
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

  const buySource = await resolveSource(opp.spreadOpp.buySource, opp.pair.quote, opp.pair.base);
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

  const sellSource = await resolveSource(opp.spreadOpp.sellSource, opp.pair.base, opp.pair.quote);
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
 * Given the scanner's preferred source, confirms it's actually usable
 * for this specific token pair via Protocolink, falling back to
 * uniswapv3 (currently the most reliably-supported source across all
 * your configured pairs) if not.
 */
async function resolveSource(
  preferredSource: string,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo
): Promise<string> {
  if (preferredSource === 'openoceanv2') {
    const ok = await isPairSupported('openoceanv2', tokenIn, tokenOut);
    if (!ok) return 'uniswapv3';
  }
  return preferredSource;
}

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
    if (source === 'uniswapv3') {
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

    if (source === 'openoceanv2') {
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

    log.warn('Unsupported or unavailable swap source requested', { source });
    return null;
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
}