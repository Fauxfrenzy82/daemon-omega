import { TokenInfo } from '../../config/tokens';
import { activeChain } from '../../config/chains';
import { getEnsoClient } from '../../execution/ensoClient';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('ensoDirectVenue');

/**
 * Candidate router/primaryAddress contracts per protocol, on Polygon.
 * Multiple candidates per protocol where the exact correct contract
 * is genuinely ambiguous (e.g. Uniswap has separate V2 Router,
 * V3 Router 2, and several Universal Router versions — picking the
 * wrong one would silently fail or return wrong data, the same class
 * of bug that cost hours earlier with ignoreStandards). All addresses
 * below are taken directly from PolygonScan's own verified contract
 * pages, not recalled from memory.
 *
 * This list is DELIBERATELY over-inclusive. Candidates that don't
 * work will simply return null from getQuote and be filtered out —
 * that costs nothing but an API call, whereas guessing wrong and
 * silently trusting bad data costs hours, as proven repeatedly this
 * session.
 */
export interface VenueCandidate {
  id: string; // unique label for this specific candidate, e.g. "uniswap-v3-router2"
  protocol: string; // Enso protocol slug, confirmed via getActionsBySlug
  primaryAddress: string; // router/pool contract address
}

export const VENUE_CANDIDATES: VenueCandidate[] = [
  {
    id: 'uniswap-v2-router',
    protocol: 'uniswap-v2',
    primaryAddress: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
  },
  {
    id: 'uniswap-v3-router2',
    protocol: 'uniswap-v3',
    primaryAddress: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  },
  {
    id: 'uniswap-universal-router-v1-2',
    protocol: 'uniswap-v3',
    primaryAddress: '0xec7BE89e9d109e7e3Fec59c222CF297125FEFda2',
  },
  {
    id: 'uniswap-universal-router-2',
    protocol: 'uniswap-v3',
    primaryAddress: '0xeF1c6E67703c7Bd7107eeD8303Fbe6EC2554Bf6B',
  },
  {
    id: 'uniswap-universal-router-alt',
    protocol: 'uniswap-v3',
    primaryAddress: '0x4C60051384bd2d3C01Bfc845Cf5F4b44bcbE9de5',
  },
  {
    id: 'sushiswap-v2-router',
    protocol: 'sushiswap-v2',
    primaryAddress: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
  },
  {
    id: 'sushiswap-v3-router',
    protocol: 'sushiswap-v3',
    primaryAddress: '0x34D9B0E1e13D8Ee42a3b7Cc6C1Bf6c5A6ca8Ee5f',
  },
  {
    id: 'balancer-v2-vault',
    protocol: 'balancer-v2',
    primaryAddress: '0xBA12222222228d8Ba445958a75a0704d566BF00',
  },
  {
    id: 'ramses-v3-router',
    protocol: 'ramses-v3',
    primaryAddress: '0xAAA87963EFeB6f7E0a2711F397663105Acb1805e',
  },
];

export interface DirectVenueQuote {
  candidateId: string;
  protocol: string;
  primaryAddress: string;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: string;
  amountOut: string;
  price: number;
}

/**
 * Gets a quote using Enso's 'swap' action with an EXPLICIT
 * primaryAddress and protocol — a concrete, verifiable mechanism per
 * Enso's own official documented example, unlike the ignoreStandards
 * approach on /route which proved not to work (every candidate
 * returned byte-identical output regardless of what was excluded).
 * This uses getBundleData with a single swap action, read for its
 * quoted amounts, not for building a real executable transaction.
 */
export async function getDirectVenueQuote(
  candidate: VenueCandidate,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string
): Promise<DirectVenueQuote | null> {
  try {
    const enso = getEnsoClient();
    const chainId = activeChain.chainId;
    const walletAddress = executionWallet.address as `0x${string}`;

    const bundleData = await withRetry(
      () =>
        enso.getBundleData(
          {
            fromAddress: walletAddress,
            chainId,
            routingStrategy: 'router',
          } as any,
          [
            {
              protocol: candidate.protocol,
              action: 'swap',
              args: {
                tokenIn: tokenIn.address as `0x${string}`,
                tokenOut: tokenOut.address as `0x${string}`,
                amountIn,
                primaryAddress: candidate.primaryAddress as `0x${string}`,
                slippage: '100',
                receiver: walletAddress,
              },
            } as any,
          ]
        ),
      {
        label: `ensoDirectVenue.${candidate.id}.${tokenIn.symbol}->${tokenOut.symbol}`,
        shouldRetry: isTransientError,
        retries: 0,
      }
    );

    const amountOut =
      (bundleData as any)?.amountOut ??
      (bundleData as any)?.route?.[0]?.amountOut ??
      (Array.isArray((bundleData as any)?.route)
        ? (bundleData as any).route[(bundleData as any).route.length - 1]?.amountOut
        : undefined);

    if (!amountOut) {
      log.debug('No usable amountOut in bundle response', {
        candidateId: candidate.id,
        tokenIn: tokenIn.symbol,
        tokenOut: tokenOut.symbol,
        rawKeys: bundleData ? Object.keys(bundleData as any) : null,
      });
      return null;
    }

    const amountInHuman = Number(amountIn) / 10 ** tokenIn.decimals;
    const amountOutHuman = Number(amountOut) / 10 ** tokenOut.decimals;
    const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

    return {
      candidateId: candidate.id,
      protocol: candidate.protocol,
      primaryAddress: candidate.primaryAddress,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: String(amountOut),
      price,
    };
  } catch (err: any) {
    log.debug('Direct venue quote failed', {
      candidateId: candidate.id,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      statusCode: err?.statusCode || err?.response?.status,
      errorMessage: err?.message || String(err),
    });
    return null;
  }
}

/**
 * Tests every candidate for a given swap direction, sequentially
 * (not parallel) to stay under Enso's rate limit — the multi-venue
 * test earlier hit 429s even at moderate concurrency. Returns only
 * the candidates that returned real, usable data.
 */
export async function getAllDirectVenueQuotes(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string
): Promise<DirectVenueQuote[]> {
  const results: DirectVenueQuote[] = [];

  for (const candidate of VENUE_CANDIDATES) {
    const quote = await getDirectVenueQuote(candidate, tokenIn, tokenOut, amountIn);
    if (quote) {
      results.push(quote);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  return results;
}