import { ethers } from 'ethers';
import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { activeChain } from '../../config/chains';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('curve-source');

// Curve 3Pool on Polygon (USDC/USDT/DAI)
const CURVE_POOL_ADDRESS = '0xE7a24EF0C5e95Ffb0f6684b813A78F2a3AD6D171';
const CURVE_POOL_ABI = [
  'function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256)',
  'function coins(uint256) external view returns (address)',
];

// Token index mapping for Curve 3Pool
const TOKEN_INDEX: Record<string, number> = {
  '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359': 0, // USDC
  '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174': 0, // USDC.e
  '0xc2132D05D31c914a87C6611C10748AEb04B58e8F': 1, // USDT
  '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063': 2, // DAI
};

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);
const pool = new ethers.Contract(CURVE_POOL_ADDRESS, CURVE_POOL_ABI, provider);

export const curveSource: PriceSource = {
  name: 'curve',
  supportsExecution: true,

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    try {
      const tokenInAddress = req.tokenIn.address.toLowerCase();
      const tokenOutAddress = req.tokenOut.address.toLowerCase();

      const indexIn = TOKEN_INDEX[tokenInAddress];
      const indexOut = TOKEN_INDEX[tokenOutAddress];

      if (indexIn === undefined || indexOut === undefined) {
        log.debug('Curve pool does not support this token pair', {
          tokenIn: req.tokenIn.symbol,
          tokenOut: req.tokenOut.symbol,
        });
        return null;
      }

      if (indexIn === indexOut) {
        return null;
      }

      const amountOut = await withRetry(
        () => pool.get_dy(indexIn, indexOut, req.amountIn),
        { label: 'curve.get_dy', shouldRetry: isTransientError }
      );

      const amountInHuman = parseFloat(ethers.utils.formatUnits(req.amountIn, req.tokenIn.decimals));
      const amountOutHuman = parseFloat(ethers.utils.formatUnits(amountOut, req.tokenOut.decimals));
      const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

      log.debug('Curve quote received', {
        tokenIn: req.tokenIn.symbol,
        tokenOut: req.tokenOut.symbol,
        amountInHuman,
        amountOutHuman,
        price,
      });

      return {
        source: 'curve',
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        amountOut: amountOut.toString(),
        price,
        supportsExecution: true,
        raw: { amountOut },
      };
    } catch (err) {
      const error = err as any;
      log.warn('Curve quote failed', {
        tokenIn: req.tokenIn.symbol,
        tokenOut: req.tokenOut.symbol,
        error: error?.message || String(err),
      });
      return null;
    }
  },
};