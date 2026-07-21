import { getEnsoClient } from '../../execution/ensoClient';
import { activeChain } from '../../config/chains';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';
import { TokenInfo } from '../../config/tokens';
import { getAllStandards, excludeStandards } from '../../config/standards';

const log = createLogger('venueExclusionSource');

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
 * Get a quote from a specific venue by excluding all other protocols.
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

    // Fetch all standards and exclude all except the target venue.
    const allStandards = await getAllStandards();
    const ignoreStandards = allStandards.filter((s) => s !== venue);

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
          ignoreStandards: ignoreStandards.length > 0 ? ignoreStandards : undefined,
        } as any),
      {
        label: `venueExcl.${venue}.${tokenIn.symbol}->${tokenOut.symbol}`,
        shouldRetry: isTransientError,
        retries: 2,
      }
    );

    const amountOut = (routeData as any)?.amountOut;
    if (!amountOut) {
      log.debug('No amountOut from venue', { venue });
      return null;
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
 * Get quotes from all DEX venues by iterating over known slugs.
 * Filters out aggregators and lending protocols.
 */
export async function getAllVenueQuotes(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string,
  excludeVenues: string[] = []
): Promise<VenueQuote[]> {
  const allStandards = await getAllStandards();
  // Keep only known DEXs – exclude aggregators and flash loan providers.
  const dexSlugs = allStandards.filter(
    (s) =>
      !['paraswap', '1inch', '0x', 'aave-v3', 'morpho-markets-v1'].includes(s) &&
      !s.includes('flashloan') &&
      !s.includes('borrow')
  );

  const venues = dexSlugs.filter((s) => !excludeVenues.includes(s));
  const results: VenueQuote[] = [];

  for (const venue of venues) {
    const quote = await getQuoteFromVenue(venue, tokenIn, tokenOut, amountIn);
    if (quote) {
      results.push(quote);
    }
    // Rate limit to avoid 429
    await new Promise((resolve) => setTimeout(resolve, 300));
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