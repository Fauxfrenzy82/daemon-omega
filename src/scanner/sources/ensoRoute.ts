import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { activeChain } from '../../config/chains';
import { getEnsoClient } from '../../execution/ensoClient';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('ensoRoute-source');

/**
 * Prices swaps using Enso's own /shortcuts/route endpoint — the SAME
 * routing engine that later builds and executes the actual flashloan
 * bundle.
 *
 * FIX: every official Enso example (docs.enso.build/pages/build/
 * get-started/route, and the SDK's llms-full.txt) shows getRouteData
 * called with THREE address fields — fromAddress, receiver, AND
 * spender — not just fromAddress. The previous version only sent
 * fromAddress, which very likely caused every single call to fail
 * silently (caught by the try/catch below, logged at warn level,
 * returning null) for the entire session — explaining why every scan
 * cycle showed "0 evaluated, 0 executable" with no visible errors.
 * For a same-wallet swap (not a delegated/smart-account flow), all
 * three should be the same execution wallet address.
 */
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
          rawResponse: JSON.stringify(routeData),
        });
        return null;
      }

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
        raw: routeData,
      };
    } catch (err: any) {
      // Elevated to ERROR (not warn) with full response body, since a
      // silent failure here is exactly what cost hours of debugging.
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