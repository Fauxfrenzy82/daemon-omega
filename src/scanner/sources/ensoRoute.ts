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
 * bundle. Confirmed field name via live diagnostic: response includes
 * amountOut, gas, priceImpact, minAmountOut, tx, and route.
 *
 * This replaces pricing via Uniswap V3 direct + ParaSwap's separate
 * price API, which routinely disagreed with Enso's real execution by
 * 100+ bps in production (e.g. scanner estimated +67 bps profit;
 * Enso's actual execution came back -84 bps short, same pair, same
 * moment). It also removes the ParaSwap dependency entirely, which
 * has begun hard rate-limiting (429s) on every request as of this
 * session — a second, independent problem this same change resolves.
 */
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