import { ethers } from 'ethers';
import { executionWallet } from '../treasury/wallets';
import { QuoteResult } from '../scanner/priceSource';
import { createLogger } from '../utils/logger';

const log = createLogger('directRouter');

// QuickSwap Router (same address)
const ROUTER_ADDRESS = '0xa5E0829CaCEd8fFDD4Ba3acaDc0c6cA7E9cDd9D3';
const ROUTER_ABI = [
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
];

const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);
const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider).connect(executionWallet);

export async function executeQuickSwapSwap(
  quote: QuoteResult,
  amountOutMin: string,
  deadline: number,
  to: string = executionWallet.address
): Promise<ethers.providers.TransactionResponse> {
  const path = [quote.tokenIn.address, quote.tokenOut.address];
  const tx = await router.swapExactTokensForTokens(
    quote.amountIn,
    amountOutMin,
    path,
    to,
    deadline
  );
  log.info('QuickSwap swap submitted', { txHash: tx.hash });
  return tx;
}