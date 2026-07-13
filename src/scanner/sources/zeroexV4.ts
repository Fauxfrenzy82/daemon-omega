import axios from 'axios';
import { ethers } from 'ethers';
import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { activeChain } from '../../config/chains';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';
import { env } from '../../config/env';

const log = createLogger('zeroexV4-source');

// 0x API V4 for Polygon
const ZEROEX_API_URL = 'https://polygon.api.0x.org';

interface ZeroExQuoteResponse {
  price: string;
  guaranteedPrice: string;
  to: string;
  data: string;
  value: string;
  gas: string;
  estimatedGas: string;
  protocolFee: string;
  buyTokenAddress: string;
  sellTokenAddress: string;
  buyAmount: string;
  sellAmount: string;
  sources: any[];
}

export const zeroexV4Source: PriceSource = {
  name: 'zeroex-v4',
  supportsExecution: true,

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    try {
      // Get API key from environment
      const apiKey = env.ZEROEX_API_KEY || '';

      if (!apiKey) {
        log.warn('ZEROEX_API_KEY not set — skipping 0x V4 quotes');
        return null;
      }

      const params = {
        sellToken: req.tokenIn.address,
        buyToken: req.tokenOut.address,
        sellAmount: req.amountIn,
        slippagePercentage: 0.01,
      };

      const response = await withRetry(
        () => axios.get<ZeroExQuoteResponse>(`${ZEROEX_API_URL}/swap/v1/quote`, {
          params,
          timeout: 5000,
          headers: {
            'Accept': 'application/json',
            '0x-api-key': apiKey,
          },
        }),
        { label: 'zeroexV4.getQuote', shouldRetry: isTransientError }
      );

      const data = response.data;
      if (!data || !data.buyAmount) {
        log.warn('0x V4 returned empty quote', {
          tokenIn: req.tokenIn.symbol,
          tokenOut: req.tokenOut.symbol,
        });
        return null;
      }

      const amountInHuman = Number(req.amountIn) / 10 ** req.tokenIn.decimals;
      const amountOutHuman = Number(data.buyAmount) / 10 ** req.tokenOut.decimals;
      const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

      return {
        source: 'zeroex-v4',
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        amountOut: data.buyAmount,
        price,
        supportsExecution: true,
        raw: data,
      };
    } catch (err) {
      const error = err as any;
      log.warn('0x V4 quote failed', {
        tokenIn: req.tokenIn.symbol,
        tokenOut: req.tokenOut.symbol,
        error: error?.message || String(err),
      });
      return null;
    }
  },
};