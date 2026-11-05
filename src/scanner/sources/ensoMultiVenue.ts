import { TokenInfo, TOKENS } from '../../config/tokens';
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

// ---------------------------------------------------------------------------
// Venue isolation mode
//
// Enso decides whether a venue-isolated route exists, and the exact parameters
// that work can't be assumed. So the first time we quote, we probe Enso once
// with a known pair and pick the most isolating mode that really works:
//   'both'      ignoreStandards (other venues) + ignoreAggregators
//   'standards' ignoreStandards (other venues) only
//   'none'      isolation unavailable -> no cross-venue scanning (no fake spreads)
// ---------------------------------------------------------------------------
type IsolationMode = 'both' | 'standards' | 'none';

const NONE_RECHECK_MS = 10 * 60 * 1000;
let modeCache: { mode: IsolationMode; at: number } | null = null;
let modePromise: Promise<IsolationMode> | null = null;

function summarizeRoute(routeData: any): string[] {
  const route = routeData?.route;
  if (!Array.isArray(route)) return [];
  return route.map((h: any) => `${h?.protocol}/${h?.action}`);
}

// 404 "Swap not found" is a normal answer ("no route"), not a failure to retry or shout about.
const NOT_FOUND = { notFound: true };

async function fetchRoute(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string,
  ignoreStandards: string[],
  ignoreAggregators: string[],
  label: string
): Promise<any> {
  const enso = getEnsoClient();
  const walletAddress = executionWallet.address as `0x${string}`;

  return withRetry(
    async () => {
      try {
        return await enso.getRouteData({
          fromAddress: walletAddress,
          receiver: walletAddress,
          spender: walletAddress,
          chainId: activeChain.chainId,
          amountIn: [amountIn],
          tokenIn: [tokenIn.address as `0x${string}`],
          tokenOut: [tokenOut.address as `0x${string}`],
          slippage: '100',
          routingStrategy: 'router',
          ignoreStandards,
          ignoreAggregators,
        } as any);
      } catch (err: any) {
        if (err?.response?.status === 404) return NOT_FOUND;
        throw err;
      }
    },
    { label, shouldRetry: isTransientError, retries: 1 }
  );
}

async function detectIsolationMode(): Promise<IsolationMode> {
  const tokenIn = TOKENS.USDC;
  const tokenOut = TOKENS.WETH;
  const amountIn = '10000000'; // 10 USDC
  const probeVenue: VenueSlug = 'uniswap-v3';
  const others: string[] = CONFIRMED_VENUES.filter((v) => v !== probeVenue);

  const baseline = await fetchRoute(tokenIn, tokenOut, amountIn, [], [], 'ensoProbe.baseline');
  log.info('Enso probe: unconstrained route', {
    found: baseline !== NOT_FOUND,
    hops: baseline === NOT_FOUND ? [] : summarizeRoute(baseline),
  });

  const attempts: Array<{ mode: IsolationMode; aggregators: string[] }> = [
    { mode: 'standards', aggregators: [] },
    { mode: 'both', aggregators: IGNORED_AGGREGATORS },
  ];

  for (const attempt of attempts) {
    const res = await fetchRoute(tokenIn, tokenOut, amountIn, others, attempt.aggregators, `ensoProbe.${attempt.mode}`);
    const found = res !== NOT_FOUND;
    const pure = found && extractVenueHops(probeVenue, res) !== null;
    log.info('Enso probe: isolation attempt', {
      mode: attempt.mode,
      found,
      pureVenueRoute: pure,
      hops: found ? summarizeRoute(res) : [],
    });
    if (pure) return attempt.mode;
  }

  log.warn('Venue isolation is NOT available: cross-venue scanning disabled until it works (rechecking every 10 min)');
  return 'none';
}

async function getIsolationMode(): Promise<IsolationMode> {
  if (modeCache && (modeCache.mode !== 'none' || Date.now() - modeCache.at < NONE_RECHECK_MS)) {
    return modeCache.mode;
  }
  if (!modePromise) {
    modePromise = detectIsolationMode()
      .then((mode) => {
        modeCache = { mode, at: Date.now() };
        log.info('Enso venue isolation mode selected', { mode });
        return mode;
      })
      .catch((err) => {
        // Transient failure (e.g. 429): don't cache, just skip this round.
        log.warn('Enso venue probe failed, will retry next cycle', { error: err?.message || String(err) });
        return 'none' as IsolationMode;
      })
      .finally(() => {
        modePromise = null;
      });
  }
  return modePromise;
}

function buildQuote(
  venue: VenueSlug,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string,
  routeData: any
): VenueQuote | null {
  if (!routeData || routeData === NOT_FOUND) return null;

  const amountOut = routeData?.amountOut;
  if (!amountOut) {
    log.debug('No route via this venue', { venue, tokenIn: tokenIn.symbol, tokenOut: tokenOut.symbol });
    return null;
  }

  const hops = extractVenueHops(venue, routeData);
  if (!hops) return null;

  const amountInHuman = Number(amountIn) / 10 ** tokenIn.decimals;
  const amountOutHuman = Number(amountOut) / 10 ** tokenOut.decimals;
  const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

  return { venue, tokenIn, tokenOut, amountIn, amountOut: String(amountOut), price, hops };
}

export async function getVenueQuote(
  venue: VenueSlug,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string
): Promise<VenueQuote | null> {
  try {
    const mode = await getIsolationMode();
    if (mode === 'none') return null;

    const ignoreStandards: string[] = CONFIRMED_VENUES.filter((v) => v !== venue);
    const ignoreAggregators = mode === 'both' ? IGNORED_AGGREGATORS : [];

    const routeData = await fetchRoute(
      tokenIn,
      tokenOut,
      amountIn,
      ignoreStandards,
      ignoreAggregators,
      `ensoMultiVenue.${venue}.${tokenIn.symbol}->${tokenOut.symbol}`
    );

    return buildQuote(venue, tokenIn, tokenOut, amountIn, routeData);
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
  const mode = await getIsolationMode();

  // No isolation: don't burn the 1 req/s budget on 7 identical-or-failing
  // requests. One unconstrained request, labelled with the venue Enso really
  // used. A single venue can't produce a cross-venue spread, so discover skips it.
  if (mode === 'none') {
    try {
      const routeData = await fetchRoute(
        tokenIn, tokenOut, amountIn, [], [],
        `ensoMultiVenue.single.${tokenIn.symbol}->${tokenOut.symbol}`
      );
      const protocol = String(routeData?.route?.[0]?.protocol ?? '').toLowerCase();
      const venue = CONFIRMED_VENUES.find((v) => v === protocol);
      const quote = venue ? buildQuote(venue, tokenIn, tokenOut, amountIn, routeData) : null;
      return quote ? [quote] : [];
    } catch {
      return [];
    }
  }

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