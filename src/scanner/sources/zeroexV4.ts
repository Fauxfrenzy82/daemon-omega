import axios from 'axios';
import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { activeChain } from '../../config/chains';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';
import { env } from '../../config/env';
import { executionWallet } from '../../treasury/wallets';

const log = createLogger('zeroexV4-source');

// 0x Swap API v2 — unified endpoint, chain selected via chainId query
// param rather than a chain-specific subdomain. The old
// polygon.api.0x.org/swap/v1/quote path is retired (returns 404); v2
// also requires a 0x-version header and a taker address, neither of
// which the old integration sent.
const ZEROEX_API_URL = 'https://api.0x.org';

interface ZeroExV2QuoteResponse {
  buyAmount: string;
  sellAmount: string;
  buyToken: string;
  sellToken: string;
  liquidityAvailable: boolean;
  transaction?: {
    to: string;
    data: string;
    value: string;
    gas: string;
  };
  issues?: {
    allowance?: { spender: string } | null;
    balance?: unknown;
  };
}

export const zeroexV4Source: PriceSource = {
  name: 'zeroex-v4',
  supportsExecution: true,

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    try {
      const apiKey = env.ZEROEX_API_KEY || '';

      if (!apiKey) {
        log.warn('ZEROEX_API_KEY not set — skipping 0x V4 quotes');
        return null;
      }

      const params = {
        chainId: activeChain.chainId,
        sellToken: req.tokenIn.address,
        buyToken: req.tokenOut.address,
        sellAmount: req.amountIn,
        taker: executionWallet.address,
      };

      const response = await withRetry(
        () =>
          axios.get<ZeroExV2QuoteResponse>(`${ZEROEX_API_URL}/swap/allowance-holder/quote`, {
            params,
            timeout: 5000,
            headers: {
              Accept: 'application/json',
              '0x-api-key': apiKey,
              '0x-version': 'v2',
            },
          }),
        { label: 'zeroexV4.getQuote', shouldRetry: isTransientError }
      );

      const data = response.data;
      if (!data || !data.buyAmount || data.liquidityAvailable === false) {
        log.warn('0x V4 returned empty or unavailable quote', {
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
        statusCode: error?.response?.status,
        response: error?.response?.data ? JSON.stringify(error.response.data) : undefined,
        error: error?.message || String(err),
      });
      return null;
    }
  },
};