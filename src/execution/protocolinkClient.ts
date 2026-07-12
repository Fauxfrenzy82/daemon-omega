import * as api from '@protocolink/api';
import { activeChain } from '../config/chains';
import { executionWallet } from '../treasury/wallets';
import { createLogger } from '../utils/logger';

const log = createLogger('protocolinkClient');

let initialized = false;

export function initProtocolink(): void {
  if (initialized) return;
  initialized = true;
  log.info('Protocolink client initialized', { chainId: activeChain.chainId });
}

export function getChainId(): number {
  return activeChain.chainId;
}

// FIX: getAgent may not exist; fallback to execution wallet address.
export async function getAgentAddress(): Promise<string> {
  // The Router can use the execution wallet as the agent directly.
  return executionWallet.address;
}

export { api };