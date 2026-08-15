import { getEnsoClient } from '../../execution/ensoClient';
import { activeChain } from '../../config/chains';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';
import { TokenInfo } from '../../config/tokens';

const log = createLogger('directDexSource');

// Only use DEXs that are confirmed to work with Enso's Bundle API.
// Router addresses verified from official docs and Etherscan.
const ROUTERS: Record<string, { protocol: string; primaryAddress: string; extraArgs?: Record<string, string> }> = {
  'uniswap-v3': {
    protocol: 'uniswap-v3',
    primaryAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    extraArgs: { poolFee: '3000' }, // will be overwritten dynamically
  },
  'sushiswap-v2': {
    protocol: 'sushiswap-v2',
    primaryAddress: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
  },
  'quickswap-v2': {
    protocol: 'uniswap-v2', // QuickSwap is a Uniswap V2 fork
    primaryAddress: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
  },
};

// Fee tier mapping based on token pair
function getPoolFee(tokenIn: TokenInfo, tokenOut: TokenInfo): string {
  const symbols = [tokenIn.symbol, tokenOut.symbol];
  if (symbols.includes('USDC') && symbols.includes('USDT')) return '500';
  if (symbols.includes('DAI') && symbols.includes('USDC')) return '500';
  if (symbols.includes('USDC') && symbols.includes('USDC.e')) return '500';
  return '3000'; // default for WETH, WBTC, etc.
}

export interface DirectDexQuote {
  venue: string;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: string;
  amountOut: string;
  price: number;
  raw: any;
}

/**
 * Pull every useful field off an unknown thrown error so we never
 * lose the real cause. Axios errors, fetch errors, and plain Errors
 * all get something meaningful out of this.
 */
function describeError(err: any): Record<string, unknown> {
  return {
    message: err?.message || String(err),
    name: err?.name,
    // axios-style
    statusCode: err?.statusCode || err?.response?.status,
    responseData: err?.response?.data ? JSON.stringify(err.response.data) : undefined,
    // fetch-style (some SDKs throw a Response or a wrapped error with .status/.body)
    status: err?.status,
    body: err?.body ? JSON.stringify(err.body) : undefined,
    // Enso SDK sometimes wraps validation errors
    cause: err?.cause ? String(err.cause) : undefined,
    stack: err?.stack,
  };
}

/**
 * Enso's Bundle API returns amountsOut as an OBJECT keyed by token
 * address (lowercase), not an array: { "0xabc...": "12345" }.
 * Do a case-insensitive lookup by the expected tokenOut address.
 */
function extractAmountOut(bundleData: any, tokenOutAddress: string): string | undefined {
  const target = tokenOutAddress.toLowerCase();

  if (bundleData?.amountsOut && typeof bundleData.amountsOut === 'object' && !Array.isArray(bundleData.amountsOut)) {
    for (const [addr, value] of Object.entries(bundleData.amountsOut)) {
      if (addr.toLowerCase() === target) {
        return value as string;
      }
    }
    // Fallback: single-entry object, just take the only value present
    const values = Object.values(bundleData.amountsOut);
    if (values.length === 1) {
      return values[0] as string;
    }
  }

  // Legacy/alternate shapes, kept as fallbacks
  if (typeof bundleData?.amountOut === 'string') {
    return bundleData.amountOut;
  }
  if (bundleData?.route && Array.isArray(bundleData.route)) {
    const lastRoute = bundleData.route[bundleData.route.length - 1];
    if (typeof lastRoute?.amountOut === 'string') {
      return lastRoute.amountOut;
    }
  }

  return undefined;
}

export async function getDirectDexQuote(
  venue: string,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string
): Promise<DirectDexQuote | null> {
  const config = ROUTERS[venue];
  if (!config) {
    log.warn('No router config for venue', { venue });
    return null;
  }

  try {
    const enso = getEnsoClient();
    const chainId = activeChain.chainId;
    const walletAddress = executionWallet.address as `0x${string}`;

    const args: any = {
      tokenIn: tokenIn.address as `0x${string}`,
      tokenOut: tokenOut.address as `0x${string}`,
      amountIn,
      primaryAddress: config.primaryAddress as `0x${string}`,
      receiver: walletAddress,
    };

    // Add protocol-specific extra args
    if (config.extraArgs) {
      // Handle dynamic poolFee
      if (config.extraArgs.poolFee) {
        args.poolFee = getPoolFee(tokenIn, tokenOut);
      }
      // Merge other extra args
      Object.assign(args, config.extraArgs);
    }

    log.info('Requesting direct DEX quote', {
      venue,
      protocol: config.protocol,
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amountIn,
    });

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
              protocol: config.protocol,
              action: 'swap',
              args,
            } as any,
          ]
        ),
      {
        label: `directDex.${venue}.${tokenIn.symbol}->${tokenOut.symbol}`,
        shouldRetry: isTransientError,
        retries: 2,
      }
    );

    const amountOut = extractAmountOut(bundleData, tokenOut.address);

    if (!amountOut) {
      log.warn('No amountOut in bundle response', {
        venue,
        expectedTokenOut: tokenOut.address,
        amountsOutKeys: bundleData?.amountsOut ? Object.keys(bundleData.amountsOut) : null,
        keys: bundleData ? Object.keys(bundleData) : null,
      });
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
      raw: bundleData,
    };
  } catch (err: any) {
    log.error('Direct DEX quote failed', {
      venue,
      ...describeError(err),
    });
    return null;
  }
}

export async function getAllDirectDexQuotes(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string,
  excludeVenues: string[] = []
): Promise<DirectDexQuote[]> {
  const venues = Object.keys(ROUTERS).filter((v) => !excludeVenues.includes(v));
  const results: DirectDexQuote[] = [];

  for (const venue of venues) {
    const quote = await getDirectDexQuote(venue, tokenIn, tokenOut, amountIn);
    if (quote) {
      results.push(quote);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  return results;
}

export function getBestQuote(quotes: DirectDexQuote[]): DirectDexQuote | null {
  if (quotes.length === 0) return null;
  return quotes.reduce((a, b) => (Number(a.amountOut) > Number(b.amountOut) ? a : b));
}