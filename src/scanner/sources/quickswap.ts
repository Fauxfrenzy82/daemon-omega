import { ethers } from 'ethers';
import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { activeChain } from '../../config/chains';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('quickswap-source');

// QuickSwap Router on Polygon
const ROUTER_ADDRESS = '0xa5E0829CaCEd8fFDD4Ba3acaDc0c6cA7E9cDd9D3';
const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
];

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);
const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);

export const quickswapSource: PriceSource = {
  name: 'quickswap',
  supportsExecution: true, // ✅ Mark as executable (we'll implement execution later)

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    try {
      const path = [req.tokenIn.address, req.tokenOut.address];
      const amounts = await withRetry(
        () => router.getAmountsOut(req.amountIn, path),
        { label: 'quickswap.getAmountsOut', shouldRetry: isTransientError }
      );
      // amounts is an array of BigNumber, but we need to handle it safely
      const amountOut = amounts[amounts.length - 1] as ethers.BigNumber;
      const amountInHuman = Number(req.amountIn) / 10 ** req.tokenIn.decimals;
      const amountOutHuman = Number(amountOut) / 10 ** req.tokenOut.decimals;
      const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

      return {
        source: 'quickswap',
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        amountOut: amountOut.toString(),
        price,
        supportsExecution: true, // ✅ Include flag in result
        raw: { amounts },
      };
    } catch (err) {
      log.warn('QuickSwap quote failed', { error: String(err) });
      return null;
    }
  },
};