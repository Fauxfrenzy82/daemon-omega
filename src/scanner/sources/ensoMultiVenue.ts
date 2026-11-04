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

// Swap aggregators Enso knows about. For a venue-isolated quote we switch most
// of them off so an aggregator cannot reroute the trade through another DEX.
// IMPORTANT: 'native' is Enso's own on-chain DEX routing. It must stay ON,
// otherwise Enso answers 404 "Swap not found" for every pair.
// Override with ENSO_KEEP_AGGREGATORS (comma separated) without a code change.
const KNOWN_AGGREGATORS = [
  '0x', '1inch', 'openocean', 'kyberswap', 'native', 'paraswap', 'bebop',
  'barter', 'sushiswap-router', 'ooga-booga', 'renegade', 'uniswap', 'rooster',
  'wowmax', 'grapher', 'hyperbloom', 'hyperswap', 'hyperflow', 'fly', 'eisen',
  'nordstern', 'everlong', 'bitget',
];

const KEEP_AGGREGATORS = (process.env.ENSO_KEEP_AGGREGATORS ?? 'native')
  .split(',')
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean);

const IGNORED_AGGREGATORS = KNOWN_AGGREGATORS.filter((a) => !KEEP_AGGREGATORS.includes(a));

// One executable swap on a specific venue, taken from Enso's own route response.
export interface VenueHop {
  protocol: string;
  action: string;
  primaryAddress: string;
  tokenIn: string;
  tokenOut: string;
  poolFee?: string;
}

export interface VenueQuote {
  venue: VenueSlug;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: string;
  amountOut: string;
  price: number;
  // The exact hops Enso would use on this venue. The bundle builder replays
  // these so the trade executes on the venue that was quoted.
  hops: VenueHop[];
}

const warnedVenues = new Set<string>();

function isAddress(a: unknown): a is string {
  return typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a);
}

function first(v: unknown): string {
  return Array.isArray(v) ? String(v[0]) : String(v);
}

/**
 * Turn Enso's route response into venue hops, or null if the route does not
 * run purely on the requested venue (fail closed: no verified venue, no quote).
 */
function extractVenueHops(venue: VenueSlug, routeData: any): VenueHop[] | null {
  const route = routeData?.route;
  if (!Array.isArray(route) || route.length === 0) return null;

  const hops: VenueHop[] = [];
  for (const h of route) {
    const protocol = String(h?.protocol ?? '').toLowerCase();
    const action = String(h?.action ?? '').toLowerCase();
    const primary = h?.primary;

    if (protocol !== venue || action !== 'swap' || !isAddress(primary)) {
      if (!warnedVenues.has(`${venue}:${protocol}:${action}`)) {
        warnedVenues.add(`${venue}:${protocol}:${action}`);
        log.warn('Venue quote discarded: route is not a pure swap on the requested venue', {
          requestedVenue: venue,
          hopProtocol: protocol,
          hopAction: action,
          hasPrimary: isAddress(primary),
        });
      }
      return null;
    }

    const poolFee = h?.args?.poolFee;
    hops.push({
      protocol,
      action,
      primaryAddress: primary,
      tokenIn: first(h.tokenIn),
      tokenOut: first(h.tokenOut),
      ...(poolFee !== undefined && poolFee !== null ? { poolFee: String(poolFee) } : {}),
    });
  }
  return hops;
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
          ignoreAggregators: IGNORED_AGGREGATORS,
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

    const hops = extractVenueHops(venue, routeData);
    if (!hops) {
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
      hops,
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