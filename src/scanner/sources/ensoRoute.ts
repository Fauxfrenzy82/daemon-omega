import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { activeChain } from '../../config/chains';
import { getEnsoClient } from '../../execution/ensoClient';
import { executionWallet } from '../../treasury/wallets';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('ensoRoute-source');

/**
 * Prices both legs using Enso's own /shortcuts/route endpoint (via
 * ensoClient.getRouteData) — the SAME routing engine that later
 * builds and executes the actual flashloan bundle. This replaces
 * the previous approach of pricing with Uniswap V3's direct quoter
 * plus ParaSwap's separate price API, then executing through Enso —
 * three different systems that routinely disagreed by 100+ bps in
 * production (e.g. scanner estimated +67 bps profit on a USDC-WBTC
 * trade; Enso's actual execution came back -84 bps short, on the
 * exact same currency pair, same moment). Pricing with the same
 * engine that executes closes that gap by construction rather than
 * by widening a slippage buffer to guess around it.
 */
export const ensoRouteSource: PriceSource = {
  name: 'enso-route',
  supportsExecution: true,

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    try {
      const enso = getEnsoClient();
      const chainId = activeChain.chainId;
      const fromAddress = executionWallet.address;

      const routeData = await withRetry(
        () =>
          enso.getRouteData({
            fromAddress,
            chainId,
            amountIn: [req.amountIn],
            tokenIn: [req.tokenIn.address],
            tokenOut: [req.tokenOut.address],
            slippage: '100', // 1%, consistent with execution-side slippage
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