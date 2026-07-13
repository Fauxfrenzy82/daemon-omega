import axios from 'axios';
import { ethers } from 'ethers';
import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { activeChain } from '../../config/chains';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('kyberswap-source');

// KyberSwap Aggregator API (Polygon)
const KYBER_API_URL = 'https://aggregator-api.kyberswap.com/polygon/api/v1';

interface KyberQuoteResponse {
  data: {
    routeSummary: {
      amountIn: string;
      amountOut: string;
      priceImpact: string;
    };
  };
}

export const kyberswapSource: PriceSource = {
  name: 'kyberswap',
  supportsExecution: true,

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    try {
      const params = {
        tokenIn: req.tokenIn.address,
        tokenOut: req.tokenOut.address,
        amountIn: req.amountIn,
      };

      const response = await withRetry(
        () => axios.get<KyberQuoteResponse>(`${KYBER_API_URL}/route`, {
          params,
          timeout: 5000,
          headers: {
            'Accept': 'application/json',
          },
        }),
        { label: 'kyberswap.getQuote', shouldRetry: isTransientError }
      );

      const data = response.data.data;
      if (!data || !data.routeSummary) {
        log.warn('KyberSwap returned empty route', {
          tokenIn: req.tokenIn.symbol,
          tokenOut: req.tokenOut.symbol,
        });
        return null;
      }

      const amountOut = data.routeSummary.amountOut;
      const amountInHuman = parseFloat(ethers.utils.formatUnits(req.amountIn, req.tokenIn.decimals));
      const amountOutHuman = parseFloat(ethers.utils.formatUnits(amountOut, req.tokenOut.decimals));
      const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

      return {
        source: 'kyberswap',
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        amountOut: amountOut,
        price,
        supportsExecution: true,
        raw: data,
      };
    } catch (err) {
      const error = err as any;
      log.warn('KyberSwap quote failed', {
        tokenIn: req.tokenIn.symbol,
        tokenOut: req.tokenOut.symbol,
        error: error?.message || String(err),
      });
      return null;
    }
  },
};