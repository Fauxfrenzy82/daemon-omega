import axios from 'axios';
import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { env } from '../../config/env';
import { activeChain } from '../../config/chains';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('paraswapV5-source');

const NATIVE_PLACEHOLDER = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

interface ParaswapPriceResponse {
  priceRoute: {
    destAmount: string;
    srcAmount: string;
    gasCost: string;
  };
}

export const paraswapV5Source: PriceSource = {
  name: 'paraswapv5',

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    try {
      const params = {
        srcToken: req.tokenIn.address,
        destToken: req.tokenOut.address,
        amount: req.amountIn,
        srcDecimals: req.tokenIn.decimals,
        destDecimals: req.tokenOut.decimals,
        side: 'SELL',
        network: activeChain.chainId,
      };

      const response = await withRetry(
        () =>
          axios.get<ParaswapPriceResponse>(`${env.PARASWAP_API_URL}/prices`, {
            params,
            timeout: 5000,
          }),
        { label: 'paraswapV5.getQuote', shouldRetry: isTransientError }
      );

      const route = response.data.priceRoute;
      if (!route || !route.destAmount) {
        return null;
      }

      const amountInHuman = Number(req.amountIn) / 10 ** req.tokenIn.decimals;
      const amountOutHuman = Number(route.destAmount) / 10 ** req.tokenOut.decimals;
      const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

      return {
        source: 'paraswapv5',
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        amountOut: route.destAmount,
        price,
        raw: route,
      };
    } catch (err) {
      log.warn('Quote failed', {
        tokenIn: req.tokenIn.symbol,
        tokenOut: req.tokenOut.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },
};

export function toParaswapAddress(address: string, isNative: boolean): string {
  return isNative ? NATIVE_PLACEHOLDER : address;
}