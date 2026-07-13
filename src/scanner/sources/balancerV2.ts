import { ethers } from 'ethers';
import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { activeChain } from '../../config/chains';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('balancerV2-source');

const VAULT_ADDRESS = '0xBA12222222228d8Ba445958a75a0704d566BF00';
const QUERY_BATCH_SWAP_ABI = [
  'function queryBatchSwap(uint8 kind, (bytes32 poolId,uint256 assetInIndex,uint256 assetOutIndex,uint256 amount,bytes userData)[] swaps, address[] assets, (address sender,bool fromInternalBalance,address recipient,bool toInternalBalance) funds) returns (int256[] assetDeltas)',
];

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);
const vault = new ethers.Contract(VAULT_ADDRESS, QUERY_BATCH_SWAP_ABI, provider);

export const KNOWN_POOL_IDS: Record<string, string> = {
  // 'WETH-USDC': '0x...poolId',
  // populate as pools are confirmed viable; left empty deliberately
};

export const balancerV2Source: PriceSource = {
  name: 'balancerv2',
  supportsExecution: true, // ✅ Can execute trades (once pool IDs are provided)

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    const pairKey = `${req.tokenIn.symbol}-${req.tokenOut.symbol}`;
    const poolId = KNOWN_POOL_IDS[pairKey];

    if (!poolId) {
      log.debug('No known pool id, skipping', { pairKey });
      return null;
    }

    try {
      const assets = [req.tokenIn.address, req.tokenOut.address];
      const swaps = [
        {
          poolId,
          assetInIndex: 0,
          assetOutIndex: 1,
          amount: req.amountIn,
          userData: '0x',
        },
      ];
      const funds = {
        sender: ethers.constants.AddressZero,
        fromInternalBalance: false,
        recipient: ethers.constants.AddressZero,
        toInternalBalance: false,
      };

      const deltas: ethers.BigNumber[] = await withRetry(
        () => vault.callStatic.queryBatchSwap(0, swaps, assets, funds),
        { label: 'balancerV2.queryBatchSwap', shouldRetry: isTransientError }
      );

      const amountOut = deltas[1].abs();

      const amountInHuman = Number(ethers.utils.formatUnits(req.amountIn, req.tokenIn.decimals));
      const amountOutHuman = Number(ethers.utils.formatUnits(amountOut, req.tokenOut.decimals));
      const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

      return {
        source: 'balancerv2',
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        amountOut: amountOut.toString(),
        price,
        supportsExecution: true, // ✅ Include flag in result
        raw: { poolId },
      };
    } catch (err) {
      log.warn('Quote failed', {
        pairKey,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },
};