import { ethers } from 'ethers';
import { env } from '../config/env';
import { activeChain } from '../config/chains';
import { createLogger } from '../utils/logger';

const log = createLogger('wallets');

// 🔥 Public RPC for reads
export const provider = new ethers.providers.JsonRpcProvider(activeChain.rpcUrl);

// 🔥 Private Mempool RPC for transaction submission (MEV protection)
// Polygon Private Mempool routes transactions directly to block producers,
// bypassing the public mempool and eliminating frontrunning/sandwich attacks[reference:5]
export const privateMempoolProvider = new ethers.providers.JsonRpcProvider(
  env.PRIVATE_MEMPOOL_RPC || 'https://private-mempool.polygon.technology'
);

// 🔥 Execution wallet using private mempool for submission
export const executionWallet = new ethers.Wallet(env.EXECUTION_PRIVATE_KEY, privateMempoolProvider);

// 🔥 Also expose the execution wallet with public provider for read operations
export const executionWalletRead = new ethers.Wallet(env.EXECUTION_PRIVATE_KEY, provider);

export function getTreasuryAddress(): string {
  if (!ethers.utils.isAddress(env.TREASURY_ADDRESS)) {
    throw new Error('TREASURY_ADDRESS is not a valid address');
  }
  return env.TREASURY_ADDRESS;
}

export async function getNativeBalance(address: string): Promise<ethers.BigNumber> {
  return provider.getBalance(address);
}

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

export async function getTokenBalance(tokenAddress: string, holder: string): Promise<ethers.BigNumber> {
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  return contract.balanceOf(holder);
}

export function getErc20Contract(tokenAddress: string, signerOrProvider = executionWallet) {
  return new ethers.Contract(tokenAddress, ERC20_ABI, signerOrProvider);
}

export function assertExecutionWalletFunded(minNativeBalance: ethers.BigNumber): Promise<boolean> {
  return getNativeBalance(executionWallet.address).then((balance) => {
    const ok = balance.gte(minNativeBalance);
    if (!ok) {
      log.warn('Execution wallet balance below minimum reserve', {
        address: executionWallet.address,
        balance: balance.toString(),
        minRequired: minNativeBalance.toString(),
      });
    }
    return ok;
  });
}