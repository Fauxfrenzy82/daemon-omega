import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { activeChain } from '../../config/chains';
import { getEnsoClient } from '../../execution/ensoClient';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';
import { env } from '../../config/env';

const log = createLogger('ensoRoute-source');

export const ensoRouteSource: PriceSource = {
  name: 'enso-route',
  supportsExecution: true,

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
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
            amountIn: [req.amountIn],
            tokenIn: [req.tokenIn.address as `0x${string}`],
            tokenOut: [req.tokenOut.address as `0x${string}`],
            slippage: '100',
            routingStrategy: 'router',
          }),
        {
          label: `enso-route.${req.tokenIn.symbol}->${req.tokenOut.symbol}`,
          shouldRetry: isTransientError,
          retries: 1,
        }
      );

      const amountOut = (routeData as any)?.amountOut;
      if (!amountOut) {
        log.warn('Enso route returned no amountOut', {
          tokenIn: req.tokenIn.symbol,
          tokenOut: req.tokenOut.symbol,
          // still log a snippet of the response to help debug (but not the full blob)
          responseKeys: routeData ? Object.keys(routeData) : null,
        });
        return null;
      }

      // Extract price impact if available and enforce threshold
      const priceImpactBps = (routeData as any)?.priceImpact;
      if (priceImpactBps !== undefined && priceImpactBps !== null) {
        const maxImpact = env.MAX_PRICE_IMPACT_BPS ?? 300;
        if (priceImpactBps > maxImpact) {
          log.debug('Enso route rejected: price impact too high', {
            tokenIn: req.tokenIn.symbol,
            tokenOut: req.tokenOut.symbol,
            priceImpactBps,
            maxAllowed: maxImpact,
          });
          return null;
        }
      }

      // Log only essential fields – no fullRouteData to avoid log bloat
      log.info('Enso route quote detail', {
        tokenIn: req.tokenIn.symbol,
        tokenOut: req.tokenOut.symbol,
        amountOut,
        priceImpactBps,
        gas: (routeData as any)?.gas,
        // do NOT log fullRouteData
      });

      const amountInHuman = Number(req.amountIn) / 10 ** req.tokenIn.decimals;
      const amountOutHuman = Number(amountOut) / 10 ** req.tokenOut.decimals;
      const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

      return {
        source: 'enso-route',
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        amountOut: String(amountOut),
        price,
        supportsExecution: true,
        raw: routeData, // kept for execution, not logged
      };
    } catch (err: any) {
      log.error('Enso route quote failed', {
        tokenIn: req.tokenIn.symbol,
        tokenOut: req.tokenOut.symbol,
        statusCode: err?.statusCode || err?.response?.status,
        responseData: err?.responseData || err?.response?.data,
        errorMessage: err?.message || String(err),
      });
      return null;
    }
  },
};

// Helper function to get Enso route quote as a standalone function for optimizer use
export async function getEnsoRouteQuote(
  tokenIn: any,
  tokenOut: any,
  amountIn: string
): Promise<any> {
  const result = await ensoRouteSource.getQuote({
    tokenIn,
    tokenOut,
    amountIn,
  });
  return result;
}