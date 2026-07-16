import { ethers } from 'ethers';
import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { activeChain } from '../../config/chains';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('uniswapV3-source');

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

const FEE_TIERS = [100, 500, 3000, 10000];

// Maximum acceptable divergence between a tiny reference quote's implied
// price and the real-size quote's implied price. A genuinely deep pool
// should give nearly identical prices for a tiny trade vs a $500 trade;
// large divergence means the pool is too thin at this size regardless
// of its raw liquidity() value being nonzero.
const MAX_PRICE_IMPACT_PCT = 5;

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);
const quoter = new ethers.Contract(QUOTER_V2_ADDRESS, QUOTER_ABI, provider);
const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);

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

  candidates.sort((a, b) => (b.liquidity.gt(a.liquidity) ? 1 : -1));
  return candidates[0];
}

async function quoteExactInput(
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  fee: number
): Promise<ethers.BigNumber> {
  const result = await quoter.callStatic.quoteExactInputSingle({
    tokenIn,
    tokenOut,
    amountIn,
    fee,
    sqrtPriceLimitX96: 0,
  });
  return result.amountOut;
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

      const amountOut = await withRetry(
        () => quoteExactInput(req.tokenIn.address, req.tokenOut.address, req.amountIn, poolInfo.fee),
        { label: 'uniswapV3.quote', shouldRetry: isTransientError }
      );

      const amountInHuman = Number(ethers.utils.formatUnits(req.amountIn, req.tokenIn.decimals));
      const amountOutHuman = Number(ethers.utils.formatUnits(amountOut, req.tokenOut.decimals));
      const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

      // Price-impact sanity check: compare against a tiny reference
      // quote (1/1000th the real size) from the SAME pool. liquidity()
      // only reflects virtual liquidity at the current tick, not full
      // depth — a pool can report nonzero liquidity while still being
      // far too thin for the real trade size, producing wildly wrong
      // prices (e.g. 47 DAI returned for 500 USDC, ~90% off real value,
      // seen in production logs). If the tiny quote's implied price
      // diverges too much from the real quote's, this pool is rejected
      // outright rather than silently used.
      const referenceAmountIn = ethers.BigNumber.from(req.amountIn).div(1000);

      if (referenceAmountIn.gt(0)) {
        try {
          const referenceAmountOut = await withRetry(
            () => quoteExactInput(req.tokenIn.address, req.tokenOut.address, referenceAmountIn.toString(), poolInfo.fee),
            { label: 'uniswapV3.referenceQuote', shouldRetry: isTransientError, retries: 1 }
          );

          const refAmountInHuman = Number(ethers.utils.formatUnits(referenceAmountIn, req.tokenIn.decimals));
          const refAmountOutHuman = Number(ethers.utils.formatUnits(referenceAmountOut, req.tokenOut.decimals));
          const referencePrice = refAmountInHuman > 0 ? refAmountOutHuman / refAmountInHuman : 0;

          if (referencePrice > 0 && price > 0) {
            const divergencePct = Math.abs((price - referencePrice) / referencePrice) * 100;

            if (divergencePct > MAX_PRICE_IMPACT_PCT) {
              log.warn('Rejecting quote: price impact too high, pool too thin for this size', {
                tokenIn: req.tokenIn.symbol,
                tokenOut: req.tokenOut.symbol,
                pool: poolInfo.pool,
                fee: poolInfo.fee,
                realPrice: price,
                referencePrice,
                divergencePct: divergencePct.toFixed(2),
              });
              return null;
            }
          }
        } catch (refErr) {
          // If the reference quote itself fails, we can't validate —
          // treat as a rejection rather than silently trusting the
          // unverified real quote.
          log.warn('Reference quote failed, cannot validate price impact, rejecting', {
            tokenIn: req.tokenIn.symbol,
            tokenOut: req.tokenOut.symbol,
            error: refErr instanceof Error ? refErr.message : String(refErr),
          });
          return null;
        }
      }

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