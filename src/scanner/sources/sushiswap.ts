import { ethers } from 'ethers';
import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { activeChain } from '../../config/chains';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('sushiswap-source');

// SushiSwap Router on Polygon
const ROUTER_ADDRESS = ethers.utils.getAddress(
  '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506'.toLowerCase()
);
const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
];

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);
const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);

export const sushiswapSource: PriceSource = {
  name: 'sushiswap',
  supportsExecution: true,

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    try {
      const path = [req.tokenIn.address, req.tokenOut.address];
      const amounts = await withRetry(
        () => router.getAmountsOut(req.amountIn, path),
        { label: 'sushiswap.getAmountsOut', shouldRetry: isTransientError }
      ) as ethers.BigNumber[];

      const amountOut = amounts[amounts.length - 1];
      const amountInHuman = Number(req.amountIn) / 10 ** req.tokenIn.decimals;
      const amountOutHuman = Number(amountOut) / 10 ** req.tokenOut.decimals;
      const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

      return {
        source: 'sushiswap',
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        amountOut: amountOut.toString(),
        price,
        supportsExecution: true,
        raw: { amounts },
      };
    } catch (err) {
      log.warn('SushiSwap quote failed', { error: String(err) });
      return null;
    }
  },
};