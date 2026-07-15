import util from 'util';
import { ethers } from 'ethers';
import * as api from '@protocolink/api';
import { activeChain } from '../config/chains';
import { executionWallet } from '../treasury/wallets';
import { createLogger } from './logger';

const log = createLogger('diagnostics');

/**
 * Safe deep inspection: limit depth and string length to prevent circular ref explosion.
 */
export function deepInspect(obj: any, label: string = 'Object'): string {
  try {
    return util.inspect(obj, {
      depth: 4,                     // limit recursion depth
      maxArrayLength: 10,           // don't expand huge arrays
      maxStringLength: 200,         // truncate long strings
      showHidden: false,
      getters: false,               // avoid triggering getters that cause circular refs
      compact: true,
      breakLength: 120,
    });
  } catch (err) {
    return `${label} [inspect failed: ${String(err)}]`;
  }
}

/**
 * Log essential token fields (no circular refs).
 */
export function logTokenEssentials(token: any, label: string = 'Token'): void {
  if (!token || typeof token !== 'object') {
    log.info(`📌 ${label} is not an object`, { type: typeof token });
    return;
  }
  log.info(`📌 ${label}`, {
    address: token.address,
    symbol: token.symbol,
    decimals: token.decimals,
    chainId: token.chainId,
    name: token.name,
  });
}

/**
 * Log environment information.
 */
export async function logEnvironment(provider: ethers.providers.Provider): Promise<void> {
  try {
    const network = await provider.getNetwork();
    const block = await provider.getBlock('latest');
    const balance = await provider.getBalance(executionWallet.address);
    const chainId = network.chainId;

    log.info('🌍 Environment Info', {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      '@protocolink/api': require('@protocolink/api/package.json').version,
      ethers: require('ethers/package.json').version,
      chainId,
      rpcUrl: activeChain.rpcUrl,
      walletAddress: executionWallet.address,
      walletBalance: ethers.utils.formatEther(balance),
      blockNumber: block.number,
      blockTimestamp: block.timestamp,
      blockHash: block.hash,
    });
  } catch (err) {
    log.warn('Failed to log environment', { error: String(err) });
  }
}

/**
 * Log the structure of the Protocolink SDK.
 */
export function logSDKStructure(): void {
  try {
    log.info('📦 SDK Protocol Keys', { keys: Object.keys(api.protocols) });
    const protocols = ['aavev3', 'balancerv2', 'paraswapv5', 'uniswapv3'];
    for (const p of protocols) {
      const proto = (api.protocols as any)[p];
      if (proto) {
        log.info(`📦 ${p} methods`, { keys: Object.keys(proto) });
        if (p === 'aavev3' || p === 'balancerv2') {
          log.info(`📦 ${p}.newFlashLoanLogicPair exists?`, {
            exists: typeof proto.newFlashLoanLogicPair === 'function',
          });
        }
      } else {
        log.warn(`📦 ${p} is undefined`);
      }
    }
  } catch (err) {
    log.warn('Failed to log SDK structure', { error: String(err) });
  }
}