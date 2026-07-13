import axios from 'axios';
import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { env } from '../../config/env';
import { activeChain } from '../../config/chains';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('1inchV5-source');

const NATIVE_PLACEHOLDER = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

// 1inch API endpoints
const ONEINCH_API_BASE = 'https://api.1inch.dev/swap/v5.2';

interface OneInchQuoteResponse {
  fromToken: { address: string; symbol: string; decimals: number };
  toToken: { address: string; symbol: string; decimals: number };
  fromTokenAmount: string;
  toTokenAmount: string;
  estimatedGas: number;
  protocols: any[];
}

export const oneInchV5Source: PriceSource = {
  name: '1inch-v5',

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    const chainId = activeChain.chainId;

    log.debug('1inch V5 quote request', {
      tokenIn: req.tokenIn.symbol,
      tokenOut: req.tokenOut.symbol,
      amountIn: req.amountIn,
      chainId,
    });

    try {
      const params = {
        src: req.tokenIn.address,
        dst: req.tokenOut.address,
        amount: req.amountIn,
        from: env.EXECUTION_WALLET || '0x0000000000000000000000000000000000000000',
        slippage: 1,
        protocols: 'DEFAULT_ROUTING_PREFERENCE',
      };

      // 1inch requires API key header (free tier available at https://portal.1inch.dev)
      const headers: any = {
        'Content-Type': 'application/json',
      };
      
      // Add API key if configured
      if (env.ONEINCH_API_KEY) {
        headers['Authorization'] = `Bearer ${env.ONEINCH_API_KEY}`;
      }

      const response = await withRetry(
        () =>
          axios.get<OneInchQuoteResponse>(
            `${ONEINCH_API_BASE}/${chainId}/quote`,
            {
              params,
              headers,
              timeout: 5000,
            }
          ),
        { label: '1inchV5.getQuote', shouldRetry: isTransientError }
      );

      const data = response.data;
      if (!data || !data.toTokenAmount || data.toTokenAmount === '0') {
        log.warn('1inch returned empty quote', {
          tokenIn: req.tokenIn.symbol,
          tokenOut: req.tokenOut.symbol,
        });
        return null;
      }

      const amountInHuman = Number(data.fromTokenAmount) / 10 ** req.tokenIn.decimals;
      const amountOutHuman = Number(data.toTokenAmount) / 10 ** req.tokenOut.decimals;
      const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

      log.debug('1inch quote received', {
        tokenIn: req.tokenIn.symbol,
        tokenOut: req.tokenOut.symbol,
        price,
        amountInHuman,
        amountOutHuman,
      });

      return {
        source: '1inch-v5',
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        amountOut: data.toTokenAmount,
        price,
        raw: data,
      };
    } catch (err) {
      const error = err as any;
      log.error('1inch quote failed — DETAILED:', {
        tokenIn: req.tokenIn.symbol,
        tokenOut: req.tokenOut.symbol,
        amountIn: req.amountIn,
        statusCode: error?.response?.status,
        responseData: error?.response?.data,
        errorMessage: error?.message || String(err),
      });
      return null;
    }
  },
};

export function to1inchAddress(address: string, isNative: boolean): string {
  return isNative ? NATIVE_PLACEHOLDER : address;
}