import util from 'util';
import { ethers } from 'ethers';
import * as api from '@protocolink/api';
import { activeChain } from '../config/chains';
import { executionWallet } from '../treasury/wallets';
import { createLogger } from './logger';

const log = createLogger('diagnostics');

/**
 * Deep inspect any object with all options enabled.
 */
export function deepInspect(obj: any, label: string = 'Object'): string {
  try {
    return util.inspect(obj, {
      depth: null,
      showHidden: true,
      getters: true,
      compact: false,
      breakLength: 80,
      maxArrayLength: null,
      maxStringLength: null,
    });
  } catch (err) {
    return `${label} [inspect failed: ${String(err)}]`;
  }
}

/**
 * Log all keys and descriptors of an object.
 */
export function logObjectStructure(obj: any, label: string): void {
  if (!obj || typeof obj !== 'object') {
    log.info(`📐 ${label} is not an object`, { type: typeof obj });
    return;
  }
  const keys = Object.keys(obj);
  const ownKeys = Reflect.ownKeys(obj);
  const descriptors = Object.getOwnPropertyDescriptors(obj);
  const proto = Object.getPrototypeOf(obj);
  const constructorName = obj.constructor?.name || 'unknown';

  log.info(`📐 ${label} structure`, {
    constructor: constructorName,
    prototype: proto?.constructor?.name,
    keys,
    ownKeys,
    descriptors: Object.keys(descriptors),
    enumerable: keys,
    nonEnumerable: ownKeys.filter(k => !keys.includes(String(k))),
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
      cwd: process.cwd(),
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
        // Also log if newFlashLoanLogicPair exists
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