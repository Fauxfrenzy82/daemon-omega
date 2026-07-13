import { ethers } from 'ethers';
import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { activeChain } from '../../config/chains';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('uniswapV3-source');

// Uniswap V3 Quoter V2 on Polygon — verified against PolygonScan,
// Etherscan, Arbiscan, and Uniswap's official docs repo. This exact
// 40-hex-char address is required; a previously-truncated 39-char
// version (missing the trailing "e") caused ethers to reject it.
const QUOTER_V2_ADDRESS = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
];

const FACTORY_ADDRESS = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

const POOL_ABI = [
  'function liquidity() external view returns (uint128)',
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

const FEE_TIERS = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1%

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);
const quoter = new ethers.Contract(QUOTER_V2_ADDRESS, QUOTER_ABI, provider);
const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);

/**
 * Checks every fee tier's pool and returns the one with the highest
 * on-chain liquidity, not just the first one that happens to exist.
 * A pool can exist with near-zero deposits and sit unused — quoting
 * against it produces a technically-valid but wildly wrong price,
 * since thin pools are trivially easy to move. This was the root
 * cause of "impossible spread" (3x+ off real market price) results:
 * the old first-match logic could pick an empty 0.01% or 0.05% pool
 * over the real, liquid 0.3% pool that most non-stable pairs actually
 * trade on.
 */
async function findBestPool(tokenA: string, tokenB: string): Promise<{ pool: string; fee: number; liquidity: ethers.BigNumber } | null> {
  const candidates: { pool: string; fee: number; liquidity: ethers.BigNumber }[] = [];

  for (const fee of FEE_TIERS) {
    try {
      const poolAddr: string = await factory.getPool(tokenA, tokenB, fee);
      if (!poolAddr || poolAddr === ethers.constants.AddressZero) continue;

      const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
      const liquidity: ethers.BigNumber = await pool.liquidity();

      if (liquidity.gt(0)) {
        candidates.push({ pool: poolAddr, fee, liquidity });
      }
    } catch {
      continue;
    }
  }

  if (candidates.length === 0) return null;

  // Pick the pool with the greatest liquidity, not the first found.
  candidates.sort((a, b) => (b.liquidity.gt(a.liquidity) ? 1 : -1));
  return candidates[0];
}

export const uniswapV3Source: PriceSource = {
  name: 'uniswapv3',
  supportsExecution: true,

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    try {
      const poolInfo = await withRetry(
        () => findBestPool(req.tokenIn.address, req.tokenOut.address),
        { label: 'uniswapV3.findBestPool', shouldRetry: isTransientError }
      );

      if (!poolInfo) {
        log.debug('No liquid pool found', { tokenIn: req.tokenIn.symbol, tokenOut: req.tokenOut.symbol });
        return null;
      }

      const result = await withRetry(
        () =>
          quoter.callStatic.quoteExactInputSingle({
            tokenIn: req.tokenIn.address,
            tokenOut: req.tokenOut.address,
            amountIn: req.amountIn,
            fee: poolInfo.fee,
            sqrtPriceLimitX96: 0,
          }),
        { label: 'uniswapV3.quote', shouldRetry: isTransientError }
      );

      const amountOut: ethers.BigNumber = result.amountOut;

      const amountInHuman = Number(ethers.utils.formatUnits(req.amountIn, req.tokenIn.decimals));
      const amountOutHuman = Number(ethers.utils.formatUnits(amountOut, req.tokenOut.decimals));
      const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

      return {
        source: 'uniswapv3',
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        amountOut: amountOut.toString(),
        price,
        estLiquidityUsd: Number(ethers.utils.formatUnits(poolInfo.liquidity, 0)),
        supportsExecution: true,
        raw: { pool: poolInfo.pool, fee: poolInfo.fee },
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