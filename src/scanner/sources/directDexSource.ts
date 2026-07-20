import { getEnsoClient } from '../../execution/ensoClient';
import { activeChain } from '../../config/chains';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';
import { TokenInfo } from '../../config/tokens';
import { DEX_CANDIDATES, DexCandidate } from '../../config/dexCandidates';

const log = createLogger('directDexSource');

export interface DirectDexQuote {
  venue: string;
  protocol: string;
  primaryAddress: string;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: string;
  amountOut: string;
  price: number;
}

/**
 * Determine poolFee based on token pair.
 */
function getPoolFee(tokenIn: TokenInfo, tokenOut: TokenInfo): string {
  const symbols = [tokenIn.symbol, tokenOut.symbol];
  if (symbols.includes('USDC') && symbols.includes('USDT')) return '500';
  if (symbols.includes('DAI') && symbols.includes('USDC')) return '500';
  // Default for WETH, WBTC, etc.
  return '3000';
}

/**
 * Get a quote from a single DEX using Enso's Bundle API with a 'swap' action.
 */
export async function getDirectDexQuote(
  candidate: DexCandidate,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string
): Promise<DirectDexQuote | null> {
  try {
    const enso = getEnsoClient();
    const chainId = activeChain.chainId;
    const walletAddress = executionWallet.address as `0x${string}`;

    const args: any = {
      tokenIn: tokenIn.address as `0x${string}`,
      tokenOut: tokenOut.address as `0x${string}`,
      amountIn,
      primaryAddress: candidate.primaryAddress as `0x${string}`,
      receiver: walletAddress,
    };

    // Add poolFee for V3 protocols
    if (candidate.protocol.includes('v3') || candidate.id.includes('v3')) {
      args.poolFee = getPoolFee(tokenIn, tokenOut);
    }

    const bundleData = await withRetry(
      () =>
        enso.getBundleData(
          {
            chainId,
            fromAddress: walletAddress,
            routingStrategy: 'router',
          } as any,
          [
            {
              protocol: candidate.protocol,
              action: 'swap',
              args,
            } as any,
          ]
        ),
      {
        label: `directDex.${candidate.id}.${tokenIn.symbol}->${tokenOut.symbol}`,
        shouldRetry: isTransientError,
        retries: 1,
      }
    );

    let amountOut: string | undefined;
    if (bundleData?.amountOut) {
      amountOut = bundleData.amountOut;
    } else if (bundleData?.route && Array.isArray(bundleData.route)) {
      const lastRoute = bundleData.route[bundleData.route.length - 1];
      amountOut = lastRoute?.amountOut;
    } else if (bundleData?.route?.amountOut) {
      amountOut = bundleData.route.amountOut;
    }

    if (!amountOut) {
      log.debug('No usable amountOut', {
        candidate: candidate.id,
        tokenIn: tokenIn.symbol,
        tokenOut: tokenOut.symbol,
      });
      return null;
    }

    const amountInHuman = Number(amountIn) / 10 ** tokenIn.decimals;
    const amountOutHuman = Number(amountOut) / 10 ** tokenOut.decimals;
    const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

    return {
      venue: candidate.id,
      protocol: candidate.protocol,
      primaryAddress: candidate.primaryAddress,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: String(amountOut),
      price,
    };
  } catch (err: any) {
    log.debug('Direct DEX quote failed', {
      candidate: candidate.id,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      error: err?.message || String(err),
    });
    return null;
  }
}

/**
 * Get quotes from all DEX candidates for a given swap direction.
 */
export async function getAllDirectDexQuotes(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string
): Promise<DirectDexQuote[]> {
  const results: DirectDexQuote[] = [];

  for (const candidate of DEX_CANDIDATES) {
    const quote = await getDirectDexQuote(candidate, tokenIn, tokenOut, amountIn);
    if (quote) {
      results.push(quote);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  return results;
}

/**
 * Get the best quote (highest amountOut) from a list of quotes.
 */
export function getBestQuote(quotes: DirectDexQuote[]): DirectDexQuote | null {
  if (quotes.length === 0) return null;
  return quotes.reduce((a, b) => (Number(a.amountOut) > Number(b.amountOut) ? a : b));
}