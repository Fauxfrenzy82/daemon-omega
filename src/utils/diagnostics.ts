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

// ... keep logEnvironment and logSDKStructure unchanged (they don't cause circular issues)