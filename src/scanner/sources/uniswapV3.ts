import { ethers } from 'ethers';
import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { activeChain } from '../../config/chains';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('uniswapV3-source');

const QUOTER_V2_ADDRESS = '0x61fFE014bA17989E743c5F6cB21bF9697530B21';

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

const FEE_TIERS = [100, 500, 3000, 10000];

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);

const quoter = new ethers.Contract(QUOTER_V2_ADDRESS, QUOTER_ABI, provider);
const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);

async function findBestPool(tokenA: string, tokenB: string): Promise<{ pool: string; fee: number } | null> {
  for (const fee of FEE_TIERS) {
    try {
      const poolAddr: string = await factory.getPool(tokenA, tokenB, fee);
      if (poolAddr && poolAddr !== ethers.constants.AddressZero) {
        return { pool: poolAddr, fee };
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function estimatePoolLiquidityUsd(poolAddress: string): Promise<number | undefined> {
  try {
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
    const liquidity: ethers.BigNumber = await pool.liquidity();
    return Number(ethers.utils.formatUnits(liquidity, 0));
  } catch {
    return undefined;
  }
}

export const uniswapV3Source: PriceSource = {
  name: 'uniswapv3',

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    try {
      const poolInfo = await withRetry(
        () => findBestPool(req.tokenIn.address, req.tokenOut.address),
        { label: 'uniswapV3.findBestPool', shouldRetry: isTransientError }
      );

      if (!poolInfo) {
        log.debug('No pool found', { tokenIn: req.tokenIn.symbol, tokenOut: req.tokenOut.symbol });
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

      const estLiquidityUsd = await estimatePoolLiquidityUsd(poolInfo.pool);

      return {
        source: 'uniswapv3',
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        amountOut: amountOut.toString(),
        price,
        estLiquidityUsd,
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