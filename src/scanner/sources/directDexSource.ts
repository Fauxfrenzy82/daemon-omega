import { getEnsoClient } from '../../execution/ensoClient';
import { activeChain } from '../../config/chains';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';
import { TokenInfo } from '../../config/tokens';
import { env } from '../../config/env';

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

// Balancer V2 is architecturally different: swaps route through a single
// shared Vault contract (verified: 0xBA12222222228d8Ba445958a75a0704d566BF2C8,
// identical address across all EVM chains including Polygon, "Balancer: Vault"
// on PolygonScan/Etherscan, $52M+ balance across chains) using a poolId,
// not per-DEX router addresses. Pools are added ONE AT A TIME, only once a
// specific poolId has been found with real TVL confirmation.
const BALANCER_V2_VAULT = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';

// Confirmed via farm.army TVL tracker (~$2.8M TVL at time of lookup):
// WMATIC/USDC/WETH/BAL "Polygon Base Pool" on Balancer V2.
const BALANCER_V2_POOL_IDS: Record<string, string> = {
  'WMATIC-USDC': '0x0297e37f1873d2dab4487aa67cd56b58e2f27875000100000000000000000002',
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
  priceImpactBps: number | null;
  raw: any;
}

function describeError(err: any): Record<string, unknown> {
  return {
    message: err?.message || String(err),
    name: err?.name,
    statusCode: err?.statusCode || err?.response?.status,
    responseData: err?.response?.data ? JSON.stringify(err.response.data) : undefined,
    status: err?.status,
    body: err?.body ? JSON.stringify(err.body) : undefined,
    cause: err?.cause ? String(err.cause) : undefined,
    stack: err?.stack,
  };
}

function extractAmountOut(bundleData: any, tokenOutAddress: string): string | undefined {
  const target = tokenOutAddress.toLowerCase();

  if (bundleData?.amountsOut && typeof bundleData.amountsOut === 'object' && !Array.isArray(bundleData.amountsOut)) {
    for (const [addr, value] of Object.entries(bundleData.amountsOut)) {
      if (addr.toLowerCase() === target) {
        return value as string;
      }
    }
    const values = Object.values(bundleData.amountsOut);
    if (values.length === 1) {
      return values[0] as string;
    }
  }

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

const MAX_PRICE_IMPACT_BPS = env.MAX_PRICE_IMPACT_BPS ?? 300;

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

    if (config.extraArgs) {
      if (config.extraArgs.poolFee) {
        args.poolFee = getPoolFee(tokenIn, tokenOut);
      }
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

    const priceImpactBps = typeof bundleData?.priceImpact === 'number' ? bundleData.priceImpact : null;

    if (priceImpactBps !== null && priceImpactBps > MAX_PRICE_IMPACT_BPS) {
      log.info('Venue discarded, price impact above threshold', {
        venue,
        tokenIn: tokenIn.symbol,
        tokenOut: tokenOut.symbol,
        priceImpactBps,
        maxAllowedBps: MAX_PRICE_IMPACT_BPS,
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
      priceImpactBps,
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

async function getBalancerV2Quote(
  pairId: string,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string
): Promise<DirectDexQuote | null> {
  const poolId = BALANCER_V2_POOL_IDS[pairId];
  if (!poolId) {
    return null;
  }

  const venue = 'balancer-v2';

  try {
    const enso = getEnsoClient();
    const chainId = activeChain.chainId;
    const walletAddress = executionWallet.address as `0x${string}`;

    const args: any = {
      tokenIn: tokenIn.address as `0x${string}`,
      tokenOut: tokenOut.address as `0x${string}`,
      amountIn,
      primaryAddress: BALANCER_V2_VAULT as `0x${string}`,
      poolId,
      receiver: walletAddress,
    };

    log.info('Requesting direct DEX quote', {
      venue,
      protocol: 'balancer-v2',
      tokenIn: tokenIn.symbol,
      tokenOut: tokenOut.symbol,
      amountIn,
      poolId,
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
              protocol: 'balancer-v2',
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
        poolId,
        amountsOutKeys: bundleData?.amountsOut ? Object.keys(bundleData.amountsOut) : null,
        keys: bundleData ? Object.keys(bundleData) : null,
      });
      return null;
    }

    const priceImpactBps = typeof bundleData?.priceImpact === 'number' ? bundleData.priceImpact : null;

    if (priceImpactBps !== null && priceImpactBps > MAX_PRICE_IMPACT_BPS) {
      log.info('Venue discarded, price impact above threshold', {
        venue,
        tokenIn: tokenIn.symbol,
        tokenOut: tokenOut.symbol,
        priceImpactBps,
        maxAllowedBps: MAX_PRICE_IMPACT_BPS,
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
      priceImpactBps,
      raw: bundleData,
    };
  } catch (err: any) {
    log.error('Direct DEX quote failed', {
      venue,
      poolId,
      ...describeError(err),
    });
    return null;
  }
}

export async function getAllDirectDexQuotes(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: string,
  excludeVenues: string[] = [],
  pairId?: string
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

  if (pairId && !excludeVenues.includes('balancer-v2')) {
    const balancerQuote = await getBalancerV2Quote(pairId, tokenIn, tokenOut, amountIn);
    if (balancerQuote) {
      results.push(balancerQuote);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  return results;
}

export function getBestQuote(quotes: DirectDexQuote[]): DirectDexQuote | null {
  if (quotes.length === 0) return null;
  return quotes.reduce((a, b) => (Number(a.amountOut) > Number(b.amountOut) ? a : b));
}