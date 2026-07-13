import { ethers } from 'ethers';
import { PriceSource, QuoteRequest, QuoteResult } from '../priceSource';
import { activeChain } from '../../config/chains';
import { createLogger } from '../../utils/logger';
import { withRetry, isTransientError } from '../../utils/retry';

const log = createLogger('balancerV2-source');

const VAULT_ADDRESS = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';
const QUERY_BATCH_SWAP_ABI = [
  'function queryBatchSwap(uint8 kind, (bytes32 poolId,uint256 assetInIndex,uint256 assetOutIndex,uint256 amount,bytes userData)[] swaps, address[] assets, (address sender,bool fromInternalBalance,address recipient,bool toInternalBalance) funds) returns (int256[] assetDeltas)',
];

// Known pool IDs for Polygon
const POOL_IDS: Record<string, string> = {
  'WETH-USDC': '0x05a0b4edc7ac7fefbd682b68cbe84552dc63a6c80002000000000000000000a5',
  'WBTC-USDC': '0x0297e37f1873d2dab4487aa67cd56b58e2f27875000200000000000000000b6',
  'WMATIC-USDC': '0x17d02230719a7f602ac2f3d180d5635a7e7e90c60002000000000000000003af',
};

// Token index mapping per pool (determined by pool's token order)
const TOKEN_INDEX_MAP: Record<string, Record<string, number>> = {
  'WETH-USDC': { '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619': 0, '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359': 1 },
  'WBTC-USDC': { '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6': 0, '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359': 1 },
  'WMATIC-USDC': { '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270': 0, '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359': 1 },
};

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);
const vault = new ethers.Contract(VAULT_ADDRESS, QUERY_BATCH_SWAP_ABI, provider);

export const balancerV2Source: PriceSource = {
  name: 'balancerv2',
  supportsExecution: true,

  async getQuote(req: QuoteRequest): Promise<QuoteResult | null> {
    const pairKey = `${req.tokenIn.symbol}-${req.tokenOut.symbol}`;
    const poolId = POOL_IDS[pairKey];

    if (!poolId) {
      log.debug('No known pool id, skipping', { pairKey });
      return null;
    }

    try {
      const assets = [req.tokenIn.address, req.tokenOut.address];
      const tokenIndexMap = TOKEN_INDEX_MAP[pairKey];
      if (!tokenIndexMap) {
        log.debug('No token index map for pair', { pairKey });
        return null;
      }

      const swaps = [{
        poolId,
        assetInIndex: tokenIndexMap[req.tokenIn.address] || 0,
        assetOutIndex: tokenIndexMap[req.tokenOut.address] || 1,
        amount: req.amountIn,
        userData: '0x',
      }];

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
      const amountInHuman = parseFloat(ethers.utils.formatUnits(req.amountIn, req.tokenIn.decimals));
      const amountOutHuman = parseFloat(ethers.utils.formatUnits(amountOut, req.tokenOut.decimals));
      const price = amountInHuman > 0 ? amountOutHuman / amountInHuman : 0;

      return {
        source: 'balancerv2',
        tokenIn: req.tokenIn,
        tokenOut: req.tokenOut,
        amountIn: req.amountIn,
        amountOut: amountOut.toString(),
        price,
        supportsExecution: true,
        raw: { poolId },
      };
    } catch (err) {
      const error = err as any;
      log.warn('Balancer quote failed', {
        pairKey,
        error: error?.message || String(err),
      });
      return null;
    }
  },
};