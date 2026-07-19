import { TokenInfo } from '../../config/tokens';
import { activeChain } from '../../config/chains';
import { getEnsoClient } from '../../execution/ensoClient';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('ensoMultiVenue');

export const CONFIRMED_VENUES = [
  'uniswap-v2',
  'uniswap-v3',
  'sushiswap-v2',
  'sushiswap-v3',
  'balancer-v2',
  'balancer-v3',
  'ramses-v3',
] as const;

export type VenueSlug = typeof CONFIRMED_VENUES[number];

export interface VenueQuote {
  venue: VenueSlug;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: string;
  amountOut: string;
  price: number;
}

export async function getVenueQuote(
  venue: VenueSlug,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string
): Promise<VenueQuote | null> {
  try {
    const enso = getEnsoClient();
    const chainId = activeChain.chainId;
    const walletAddress = executionWallet.address as `0x${string}`;

    const ignoreStandards = CONFIRMED_VENUES.filter((v) => v !== venue);

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
          ignoreStandards,
        } as any),
      {
        label: `ensoMultiVenue.${venue}.${tokenIn.symbol}->${tokenOut.symbol}`,
        shouldRetry: isTransientError,
        retries: 1,
      }
    );

    const amountOut = (routeData as any)?.amountOut;
    if (!amountOut) {
      log.debug('No route via this venue', { venue, tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol });
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
    };
  } catch (err: any) {
    log.debug('Venue quote failed', {
      venue,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      statusCode: err?.statusCode || err?.response?.status,
      errorMessage: err?.message || String(err),
    });
    return null;
  }
}

export async function getAllVenueQuotes(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string
): Promise<VenueQuote[]> {
  const results = await Promise.all(
    CONFIRMED_VENUES.map((venue) => getVenueQuote(venue, tokenIn, tokenOut, amountIn))
  );
  return results.filter((r): r is VenueQuote => r !== null);
}

export interface VenueSpread {
  pairId: string;
  buyVenue: VenueSlug;
  sellVenue: VenueSlug;
  buyQuote: VenueQuote;
  sellQuote: VenueQuote;
  spreadBps: number;
}

export function findBestVenueSpread(
  pairId: string,
  buyQuotes: VenueQuote[],
  sellQuotes: VenueQuote[]
): VenueSpread | null {
  if (buyQuotes.length === 0 || sellQuotes.length === 0) {
    return null;
  }

  let best: VenueSpread | null = null;

  for (const buyQuote of buyQuotes) {
    for (const sellQuote of sellQuotes) {
      const baseReceived = Number(buyQuote.amountOut) / 10 ** buyQuote.tokenOut.decimals;
      const quoteReturned = baseReceived * sellQuote.price;
      const quoteStarted = Number(buyQuote.amountIn) / 10 ** buyQuote.tokenIn.decimals;

      const spreadBps = ((quoteReturned - quoteStarted) / quoteStarted) * 10000;

      if (!best || spreadBps > best.spreadBps) {
        best = {
          pairId,
          buyVenue: buyQuote.venue,
          sellVenue: sellQuote.venue,
          buyQuote,
          sellQuote,
          spreadBps,
        };
      }
    }
  }

  return best;
}