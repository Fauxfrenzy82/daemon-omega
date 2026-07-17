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
      const fromAddress = executionWallet.address as `0x${string}`;

      const routeData = await withRetry(
        () =>
          enso.getRouteData({
            fromAddress,
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

      // TEMPORARY DIAGNOSTIC — remove once the real field name for the
      // output amount is confirmed from a live response.
      console.log('ENSO_ROUTE_DIAGNOSTIC_START');
      console.log(JSON.stringify(routeData));
      console.log('ENSO_ROUTE_DIAGNOSTIC_END');

      const amountOut = (routeData as any)?.amountOut;
      if (!amountOut) {
        log.debug('Enso route returned no amountOut', {
          tokenIn: req.tokenIn.symbol,
          tokenOut: req.tokenOut.symbol,
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
    } catch (err) {
      log.warn('Enso route quote failed', {
        tokenIn: req.tokenIn.symbol,
        tokenOut: req.tokenOut.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },
};