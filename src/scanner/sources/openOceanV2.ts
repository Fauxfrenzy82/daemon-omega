import axios from 'axios';
import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';
import { openOceanLimiter } from '../../utils/rateLimiter';

const log = createLogger('openOceanV2-source');

interface OpenOceanQuoteResponse {
  code: number;
  data?: {
    outAmount: string;
    inAmount: string;
    estimatedGas: string;
  };
}

export const openOceanV2Source: PriceSource = {
  name: 'openoceanv2',

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    try {
      // Wait for a rate-limit token before firing the request, rather
      // than firing and hoping — this keeps every call under
      // OpenOcean's published 2 req/sec public-plan cap regardless of
      // how many pairs the scanner is checking per cycle.
      await openOceanLimiter.acquire();

      const params = {
        inTokenAddress: req.tokenIn.address,
        outTokenAddress: req.tokenOut.address,
        amount: (Number(req.amountIn) / 10 ** req.tokenIn.decimals).toString(),
        gasPrice: '50',
      };

      const response = await withRetry(
        () =>
          axios.get<OpenOceanQuoteResponse>(`${env.OPENOCEAN_API_URL}/quote`, {
            params,
            timeout: 5000,
          }),
        { label: 'openOceanV2.getQuote', shouldRetry: isTransientError }
      );

      if (response.data.code !== 200 || !response.data.data) {
        return null;
      }

      const data = response.data.data;
      const amountInHuman = Number(req.amountIn) / 10 ** req.tokenIn.decimals;
      const amountOutHuman = Number(data.outAmount) / 10 ** req.tokenOut.decimals;
      const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

      return {
        source: 'openoceanv2',
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        amountOut: data.outAmount,
        price,
        raw: data,
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