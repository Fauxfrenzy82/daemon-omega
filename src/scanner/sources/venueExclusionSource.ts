import { getEnsoClient } from '../../execution/ensoClient';
import { activeChain } from '../../config/chains';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';
import { TokenInfo } from '../../config/tokens';

const log = createLogger('venueExclusionSource');

// Hardcoded DEX slugs that we know work with Enso's `protocol` parameter.
const DEX_SLUGS = [
  'uniswap-v3',
  'sushiswap-v2',
  'sushiswap-v3',
  'balancer-v2',
  'kyberswap',
  'ramses-v3',
  'dodo-v2',
  'woofi-v2',
  'curve',
];

export interface VenueQuote {
  venue: string;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: string;
  amountOut: string;
  price: number;
  raw: any;
}

/**
 * Get a quote from a specific protocol using the `protocol` parameter.
 * This forces Enso to use ONLY that protocol – no aggregation.
 */
export async function getQuoteFromVenue(
  venue: string,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string
): Promise<VenueQuote | null> {
  try {
    const enso = getEnsoClient();
    const chainId = activeChain.chainId;
    const walletAddress = executionWallet.address as `0x${string}`;

    const routeData = await withRetry(
      () =>
        enso.getRouteData({
          fromAddress: walletAddress,
          receiver: walletAddress,
          spender: walletAddress,
          chainId,
          amountIn: [amountIn],
          tokenIn: [tokenIn.address as `0x${string}`],
          tokenOut: [tokenOut.address as `0x${string}`],
          slippage: '100',
          routingStrategy: 'router',
          protocol: venue, // ✅ FORCES the route to use ONLY this protocol
        } as any),
      {
        label: `venue.${venue}.${tokenIn.symbol}->${tokenOut.symbol}`,
        shouldRetry: isTransientError,
        retries: 2,
      }
    );

    const amountOut = (routeData as any)?.amountOut;
    if (!amountOut) {
      log.debug('No amountOut from venue', { venue });
      return null;
    }

    // Verify that the actual route only used the requested protocol.
    const actualProtocols = (routeData as any)?.route?.map((step: any) => step.protocol) || [];
    if (!actualProtocols.every((p: string) => p === venue)) {
      log.warn('Route used multiple protocols despite protocol param', {
        venue,
        actualProtocols,
      });
      // Still return the quote; the user can decide.
    }

    const amountInHuman = Number(amountIn) / 10 ** tokenIn.decimals;
    const amountOutHuman = Number(amountOut) / 10 ** tokenOut.decimals;
    const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

    return {
      venue,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: String(amountOut),
      price,
      raw: routeData,
    };
  } catch (err: any) {
    log.debug('Venue quote failed', {
      venue,
      error: err?.message || String(err),
    });
    return null;
  }
}

/**
 * Get quotes from all DEX venues by iterating over hardcoded slugs.
 */
export async function getAllVenueQuotes(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string,
  excludeVenues: string[] = []
): Promise<VenueQuote[]> {
  const venues = DEX_SLUGS.filter((s) => !excludeVenues.includes(s));
  const results: VenueQuote[] = [];

  for (const venue of venues) {
    const quote = await getQuoteFromVenue(venue, tokenIn, tokenOut, amountIn);
    if (quote) {
      results.push(quote);
    }
    // Rate limit to avoid 429
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  return results;
}

/**
 * Get the best quote (highest amountOut) from a list.
 */
export function getBestVenueQuote(quotes: VenueQuote[]): VenueQuote | null {
  if (quotes.length === 0) return null;
  return quotes.reduce((a, b) => (Number(a.amountOut) > Number(b.amountOut) ? a : b));
}