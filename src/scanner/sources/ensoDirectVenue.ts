import { TokenInfo } from '../../config/tokens';
import { activeChain } from '../../config/chains';
import { getEnsoClient } from '../../execution/ensoClient';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('ensoDirectVenue');

export interface VenueCandidate {
  id: string;
  protocol: string;
  primaryAddress: string;
  poolFee?: number; // required for V3-style concentrated-liquidity protocols
}

/**
 * FIXES applied from real diagnostic errors (not guesses this time):
 * 1. uniswap-v2-router REMOVED: the address used
 *    (0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D) is Uniswap's
 *    ETHEREUM MAINNET router — using it on Polygon (chain 137)
 *    caused a real on-chain revert, confirmed by the error message.
 *    Uniswap V2 was not natively deployed on Polygon at this address;
 *    Enso's "uniswap-v2" slug on Polygon needs its own verified
 *    Polygon-specific address, not reused from another chain.
 * 2. poolFee ADDED to every V3-style protocol (uniswap-v3,
 *    sushiswap-v3, ramses-v3) — confirmed required by Enso's own
 *    error message. Testing the most common fee tiers per pair since
 *    the correct tier isn't known in advance; getAllDirectVenueQuotes
 *    below tries multiple fee tiers per V3 protocol and keeps
 *    whichever succeeds.
 * 3. balancer-v2 REMOVED for now: requires a specific poolId (Vault
 *    architecture), not just the Vault address — same lesson learned
 *    with Balancer earlier this project. Needs real poolId research
 *    before re-adding, not another guess.
 */
export const VENUE_CANDIDATES: VenueCandidate[] = [
  {
    id: 'uniswap-v3-500',
    protocol: 'uniswap-v3',
    primaryAddress: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    poolFee: 500,
  },
  {
    id: 'uniswap-v3-3000',
    protocol: 'uniswap-v3',
    primaryAddress: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    poolFee: 3000,
  },
  {
    id: 'uniswap-v3-10000',
    protocol: 'uniswap-v3',
    primaryAddress: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    poolFee: 10000,
  },
  {
    id: 'uniswap-v3-100',
    protocol: 'uniswap-v3',
    primaryAddress: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    poolFee: 100,
  },
  {
    id: 'sushiswap-v3-500',
    protocol: 'sushiswap-v3',
    primaryAddress: '0x34D9B0E1e13D8Ee42a3b7Cc6C1Bf6c5A6ca8Ee5f',
    poolFee: 500,
  },
  {
    id: 'sushiswap-v3-3000',
    protocol: 'sushiswap-v3',
    primaryAddress: '0x34D9B0E1e13D8Ee42a3b7Cc6C1Bf6c5A6ca8Ee5f',
    poolFee: 3000,
  },
  {
    id: 'sushiswap-v3-10000',
    protocol: 'sushiswap-v3',
    primaryAddress: '0x34D9B0E1e13D8Ee42a3b7Cc6C1Bf6c5A6ca8Ee5f',
    poolFee: 10000,
  },
  {
    id: 'ramses-v3-500',
    protocol: 'ramses-v3',
    primaryAddress: '0xAAA87963EFeB6f7E0a2711F397663105Acb1805e',
    poolFee: 500,
  },
  {
    id: 'ramses-v3-3000',
    protocol: 'ramses-v3',
    primaryAddress: '0xAAA87963EFeB6f7E0a2711F397663105Acb1805e',
    poolFee: 3000,
  },
];

export interface DirectVenueQuote {
  candidateId: string;
  protocol: string;
  primaryAddress: string;
  poolFee?: number;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: string;
  amountOut: string;
  price: number;
}

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

    const swapArgs: any = {
      tokenIn: tokenIn.address as `0x${string}`,
      tokenOut: tokenOut.address as `0x${string}`,
      amountIn,
      primaryAddress: candidate.primaryAddress as `0x${string}`,
      slippage: '100',
      receiver: walletAddress,
    };

    if (candidate.poolFee !== undefined) {
      swapArgs.poolFee = candidate.poolFee;
    }

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
              args: swapArgs,
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
      poolFee: candidate.poolFee,
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