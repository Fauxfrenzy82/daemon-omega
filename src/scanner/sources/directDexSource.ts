import { getEnsoClient } from '../../execution/ensoClient';
import { activeChain } from '../../config/chains';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';
import { TokenInfo } from '../../config/tokens';

const log = createLogger('directDexSource');

// Polygon router addresses – verified from official docs and Etherscan
const ROUTERS: Record<string, { protocol: string; primaryAddress: string; extraArgs?: Record<string, string> }> = {
  'uniswap-v3': {
    protocol: 'uniswap-v3',
    primaryAddress: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    extraArgs: { poolFee: '3000' }, // filled dynamically
  },
  'sushiswap-v2': {
    protocol: 'sushiswap-v2',
    primaryAddress: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
  },
  'sushiswap-v3': {
    protocol: 'sushiswap-v3',
    primaryAddress: '0x00f23572b16c5e9e58e7b965def51ff8ff546e34',
    extraArgs: { poolFee: '3000' },
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
  return '3000'; // default for WETH, WBTC
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

export async function getDirectDexQuote(
  venue: string,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string
): Promise<DirectDexQuote | null> {
  const config = ROUTERS[venue];
  if (!config) {
    log.debug('No router config for venue', { venue });
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

    // Extract amountOut – use amountsOut array (plural) from BundleData
    let amountOut: string | undefined;
    if (bundleData?.amountsOut && Array.isArray(bundleData.amountsOut) && bundleData.amountsOut.length > 0) {
      amountOut = bundleData.amountsOut[0];
    } else if ((bundleData as any)?.amountOut) {
      amountOut = (bundleData as any).amountOut;
    } else if (bundleData?.route && Array.isArray(bundleData.route)) {
      const lastRoute = bundleData.route[bundleData.route.length - 1];
      amountOut = (lastRoute as any)?.amountOut;
    }

    if (!amountOut) {
      log.debug('No amountOut in bundle response', { venue, keys: bundleData ? Object.keys(bundleData) : null });
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
    log.debug('Direct DEX quote failed', {
      venue,
      error: err?.message || String(err),
      statusCode: err?.statusCode || err?.response?.status,
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