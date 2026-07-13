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
  supportsExecution: false, // ❌ OpenOcean V2 does NOT support execution on Polygon

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    try {
      await openOceanLimiter.acquire();

      const params = {
        inTokenAddress: req.tokenIn.address,
        outTokenAddress: req.tokenOut.address,
        amount: (Number(req.amountIn) / 10 ** req.tokenIn.decimals).toString(),
        gasPrice: '50',
      };

      log.debug('OpenOcean quote request', {
        tokenIn: req.tokenIn.symbol,
        tokenOut: req.tokenOut.symbol,
        amount: params.amount,
        inTokenAddress: req.tokenIn.address,
        outTokenAddress: req.tokenOut.address,
      });

      const response = await withRetry(
        () =>
          axios.get<OpenOceanQuoteResponse>(`${env.OPENOCEAN_API_URL}/quote`, {
            params,
            timeout: 5000,
          }),
        { label: 'openOceanV2.getQuote', shouldRetry: isTransientError }
      );

      if (response.data.code !== 200 || !response.data.data) {
        log.warn('OpenOcean quote returned non-200 code', {
          code: response.data.code,
          data: response.data.data,
        });
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
        supportsExecution: false, // ❌ Mark as quote-only
        raw: data,
      };
    } catch (err) {
      const error = err as any;
      log.error('OpenOcean quote failed — DETAILED:', {
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