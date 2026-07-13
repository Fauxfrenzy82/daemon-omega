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
  name: 'paraswap-v5',
  supportsExecution: true, // ✅ Can execute trades

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    log.debug('ParaSwap V5 quote request', {
      tokenIn: req.tokenIn.symbol,
      tokenOut: req.tokenOut.symbol,
      amountIn: req.amountIn,
      chainId: activeChain.chainId,
    });

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
        log.warn('ParaSwap V5 returned empty route', {
          tokenIn: req.tokenIn.symbol,
          tokenOut: req.tokenOut.symbol,
        });
        return null;
      }

      const amountInHuman = Number(req.amountIn) / 10 ** req.tokenIn.decimals;
      const amountOutHuman = Number(route.destAmount) / 10 ** req.tokenOut.decimals;
      const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

      return {
        source: 'paraswap-v5',
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        amountOut: route.destAmount,
        price,
        supportsExecution: true, // ✅ Include flag in result
        raw: route,
      };
    } catch (err) {
      const error = err as any;
      log.error('ParaSwap V5 quote failed — DETAILED:', {
        tokenIn: req.tokenIn.symbol,
        tokenOut: req.tokenOut.symbol,
        amountIn: req.amountIn,
        tokenInAddress: req.tokenIn.address,
        tokenOutAddress: req.tokenOut.address,
        statusCode: error?.response?.status,
        responseData: error?.response?.data,
        errorMessage: error?.message || String(err),
      });
      return null;
    }
  },
};

export function toParaswapAddress(address: string, isNative: boolean): string {
  return isNative ? NATIVE_PLACEHOLDER : address;
}