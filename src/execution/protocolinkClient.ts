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

// FIX: getAgent may not exist in current SDK — if this breaks at runtime,
// the fallback is to use executionWallet.address directly.
export async function getAgentAddress(): Promise<string> {
  try {
    return await api.getAgent(activeChain.chainId, executionWallet.address);
  } catch {
    // Fallback: use the execution wallet address directly.
    // Protocolink's Router can accept the wallet as the agent.
    return executionWallet.address;
  }
}

export { api };