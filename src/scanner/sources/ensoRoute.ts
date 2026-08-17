import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { activeChain } from '../../config/chains';
import { getEnsoClient } from '../../execution/ensoClient';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

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
          rawResponse: JSON.stringify(routeData),
        });
        return null;
      }

      // Full visibility into what Enso's router actually did internally —
      // which protocols/pools it used, gas estimate, price impact if
      // present, route hops — logged in full so quote quality can be
      // judged after the fact rather than guessed at. Deliberately
      // unfiltered since the SDK's exact response shape isn't available
      // to inspect locally (node_modules not present in this checkout).
      log.info('Enso route quote detail', {
        tokenIn: req.tokenIn.symbol,
        tokenOut: req.tokenOut.symbol,
        amountOut,
        fullRouteData: JSON.stringify(routeData),
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
        raw: routeData,
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