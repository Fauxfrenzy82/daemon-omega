import { ethers } from 'ethers';
import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { activeChain } from '../../config/chains';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('quickswap-source');

// ✅ CORRECT QuickSwap Router address on Polygon Mainnet
const ROUTER_ADDRESS = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff';
const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
];

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);
const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);

export const quickswapSource: PriceSource = {
  name: 'quickswap',
  supportsExecution: true,

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    try {
      // Validate amount
      const amountInBN = ethers.BigNumber.from(req.amountIn);
      if (amountInBN.isZero()) {
        log.warn('Amount is zero, skipping quote', {
          tokenIn: req.tokenIn.symbol,
          tokenOut: req.tokenOut.symbol,
        });
        return null;
      }

      // Build token path
      const path = [req.tokenIn.address, req.tokenOut.address];
      log.debug('QuickSwap quote request', {
        tokenIn: req.tokenIn.symbol,
        tokenOut: req.tokenOut.symbol,
        amountIn: req.amountIn,
        path,
      });

      const amounts = await withRetry(
        () => router.getAmountsOut(req.amountIn, path),
        { label: 'quickswap.getAmountsOut', shouldRetry: isTransientError }
      ) as ethers.BigNumber[];

      if (!amounts || amounts.length < 2) {
        log.warn('QuickSwap returned invalid amounts', { amounts });
        return null;
      }

      const amountOut = amounts[amounts.length - 1];

      // Decimal handling: convert raw amounts to human-readable
      const amountInHuman = parseFloat(ethers.utils.formatUnits(req.amountIn, req.tokenIn.decimals));
      const amountOutHuman = parseFloat(ethers.utils.formatUnits(amountOut, req.tokenOut.decimals));

      // Price = tokenOut per 1 tokenIn
      const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

      log.debug('QuickSwap quote received', {
        tokenIn: req.tokenIn.symbol,
        tokenOut: req.tokenOut.symbol,
        amountInHuman,
        amountOutHuman,
        price,
      });

      return {
        source: 'quickswap',
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        amountOut: amountOut.toString(),
        price,
        supportsExecution: true,
        raw: { amounts },
      };
    } catch (err) {
      const error = err as any;
      // Log detailed error for debugging
      log.error('QuickSwap quote failed — DETAILED:', {
        tokenIn: req.tokenIn.symbol,
        tokenOut: req.tokenOut.symbol,
        amountIn: req.amountIn,
        errorMessage: error?.message || String(err),
        errorCode: error?.code,
        errorReason: error?.reason,
        data: error?.data ? (typeof error.data === 'string' ? error.data : JSON.stringify(error.data)) : undefined,
      });
      return null;
    }
  },
};